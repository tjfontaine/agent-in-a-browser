import Foundation
import Network
import OSLog

// MLX requires Metal GPU which is not available on iOS Simulator
#if canImport(MLXLLM) && !targetEnvironment(simulator)
import MLXLLM
import MLXLMCommon
#endif

/// OpenAI-compatible HTTP server for MLX on-device models.
/// Allows the rig-core WASM agent to use local open-weights LLMs via familiar OpenAI endpoints.
/// Note: MLX requires Metal GPU and only works on physical devices, not Simulator.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class MLXServer {
    static let shared = MLXServer()
    
    private let port: UInt16 = 11535
    private var listener: NWListener?
    private var isRunning = false
    
    #if canImport(MLXLLM) && !targetEnvironment(simulator)
    private var modelContainer: ModelContainer?
    private var session: ChatSession?
    #endif
    
    private let httpQueue = DispatchQueue(label: "com.edgeagent.mlx.http", qos: .userInitiated)
    
    private init() {}
    
    // MARK: - Availability
    
    /// MLX is only available on physical devices with Metal GPU
    static var isAvailable: Bool {
        #if canImport(MLXLLM) && !targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
    
    // MARK: - Server Lifecycle
    
    var baseURL: String {
        "http://localhost:\(port)"
    }
    
    /// Load a model from HuggingFace hub
    func loadModel(id: String) async throws {
        #if canImport(MLXLLM) && !targetEnvironment(simulator)
        Log.agent.info("MLX: Loading model \(id)...")
        modelContainer = try await LLMModelFactory.shared.loadContainer(
            configuration: ModelConfiguration(id: id)
        )
        session = ChatSession(modelContainer!)
        Log.agent.info("MLX: Model loaded successfully")
        #else
        throw MLXServerError.notAvailable
        #endif
    }
    
    func start() async throws {
        guard !isRunning else { return }
        
        #if canImport(MLXLLM) && !targetEnvironment(simulator)
        guard modelContainer != nil else {
            Log.agent.warning("MLX: No model loaded, cannot start server")
            throw MLXServerError.noModelLoaded
        }
        #else
        throw MLXServerError.notAvailable
        #endif
        
        // Start HTTP server
        let parameters = NWParameters.tcp
        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        
        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                Log.agent.info("MLX server ready on port \(self.port)")
            case .failed(let error):
                Log.agent.error("MLX server failed: \(error)")
            default:
                break
            }
        }
        
        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }
        
        listener?.start(queue: httpQueue)
        isRunning = true
        Log.agent.info("MLX OpenAI-compatible server started on \(baseURL)")
    }
    
    func stop() {
        listener?.cancel()
        listener = nil
        isRunning = false
        Log.agent.info("MLX server stopped")
    }
    
    // MARK: - Connection Handling
    
    private nonisolated func handleConnection(_ connection: NWConnection) {
        connection.start(queue: httpQueue)
        
        var requestBuffer = Data()
        
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
                guard self != nil else {
                    connection.cancel()
                    return
                }
                
                if let error = error {
                    Log.agent.error("MLX receive error: \(error)")
                    connection.cancel()
                    return
                }
                
                if let data = data {
                    requestBuffer.append(data)
                }
                
                // Check for complete HTTP request
                let headerSeparator = Data("\r\n\r\n".utf8)
                if let headerEndRange = requestBuffer.range(of: headerSeparator) {
                    let headerData = requestBuffer[..<headerEndRange.lowerBound]
                    
                    // Parse Content-Length
                    var contentLength = 0
                    if let headersString = String(data: headerData, encoding: .utf8) {
                        for line in headersString.split(separator: "\r\n") {
                            if line.lowercased().hasPrefix("content-length:") {
                                let value = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                                contentLength = Int(value) ?? 0
                            }
                        }
                    }
                    
                    let bodyStartIndex = headerEndRange.upperBound
                    let currentBodyLength = requestBuffer.count - bodyStartIndex
                    
                    if currentBodyLength >= contentLength {
                        let fullRequest = requestBuffer
                        Task { @MainActor [weak self] in
                            guard let self = self else { return }
                            let response = await self.handleHTTPRequest(fullRequest)
                            connection.send(content: response, completion: .contentProcessed { _ in
                                connection.cancel()
                            })
                        }
                        return
                    }
                }
                
                if error != nil || isComplete {
                    connection.cancel()
                } else {
                    readMore()
                }
            }
        }
        
        readMore()
    }
    
    // MARK: - HTTP Request Handling
    
    private func handleHTTPRequest(_ data: Data) async -> Data {
        guard let requestString = String(data: data, encoding: .utf8) else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid encoding\"}")
        }
        
        let lines = requestString.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid request\"}")
        }
        
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid request line\"}")
        }
        
        let method = String(parts[0])
        let path = String(parts[1])
        
        switch (method, path) {
        case ("GET", "/health"):
            return httpResponse(status: 200, body: "{\"status\": \"ok\"}")
            
        case ("GET", "/v1/models"):
            return handleModels()
            
        case ("POST", "/v1/chat/completions"):
            guard let bodyStart = requestString.range(of: "\r\n\r\n")?.upperBound else {
                return httpResponse(status: 400, body: "{\"error\": \"No body\"}")
            }
            let body = String(requestString[bodyStart...])
            return await handleChatCompletions(body: body)
            
        default:
            return httpResponse(status: 404, body: "{\"error\": \"Not found\"}")
        }
    }
    
    // MARK: - Endpoint Handlers
    
    private func handleModels() -> Data {
        let response = ModelsResponse(
            object: "list",
            data: [
                OpenAIModelInfo(
                    id: "mlx-local",
                    object: "model",
                    created: Int(Date().timeIntervalSince1970),
                    ownedBy: "local"
                )
            ]
        )
        
        guard let jsonData = try? JSONEncoder().encode(response),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return httpResponse(status: 500, body: "{\"error\": \"Encoding failed\"}")
        }
        
        return httpResponse(status: 200, body: jsonString)
    }
    
    private func handleChatCompletions(body: String) async -> Data {
        #if canImport(MLXLLM) && !targetEnvironment(simulator)
        guard let bodyData = body.data(using: .utf8),
              let request = try? JSONDecoder().decode(ChatCompletionRequest.self, from: bodyData) else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid JSON\"}")
        }
        
        guard let session = session else {
            return httpResponse(status: 500, body: "{\"error\": \"Model not loaded\"}")
        }
        
        // Build prompt from last user message
        let userMessage = request.messages.last { $0.role == "user" }?.content ?? ""
        
        let requestId = "chatcmpl-\(UUID().uuidString.prefix(8))"
        let created = Int(Date().timeIntervalSince1970)
        
        do {
            let response = try await session.respond(to: userMessage)
            
            let chatResponse = ChatCompletionResponse(
                id: requestId,
                object: "chat.completion",
                created: created,
                model: "mlx-local",
                choices: [
                    ChatChoice(
                        index: 0,
                        message: ChatMessage(role: "assistant", content: response),
                        finishReason: "stop"
                    )
                ],
                usage: nil
            )
            
            guard let jsonData = try? JSONEncoder().encode(chatResponse),
                  let jsonString = String(data: jsonData, encoding: .utf8) else {
                return httpResponse(status: 500, body: "{\"error\": \"Encoding failed\"}")
            }
            
            return httpResponse(status: 200, body: jsonString)
        } catch {
            return httpResponse(status: 500, body: "{\"error\": \"\(error.localizedDescription)\"}")
        }
        #else
        return httpResponse(status: 500, body: "{\"error\": \"MLX not available\"}")
        #endif
    }
    
    // MARK: - HTTP Response Helpers
    
    private func httpResponse(status: Int, body: String) -> Data {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        default: statusText = "Unknown"
        }
        
        let response = """
        HTTP/1.1 \(status) \(statusText)\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """
        
        return Data(response.utf8)
    }
}

// MARK: - Errors

enum MLXServerError: Error, LocalizedError {
    case notAvailable
    case noModelLoaded
    case loadFailed(String)
    
    var errorDescription: String? {
        switch self {
        case .notAvailable:
            return "MLX is not available on this device"
        case .noModelLoaded:
            return "No model has been loaded"
        case .loadFailed(let msg):
            return "Model load failed: \(msg)"
        }
    }
}
