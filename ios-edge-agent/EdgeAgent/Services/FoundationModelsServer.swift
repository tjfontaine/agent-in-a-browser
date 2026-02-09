import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif
import Network
import OSLog

/// OpenAI-compatible HTTP server for Apple's on-device Foundation Models.
/// Allows the rig-core WASM agent to use local inference via familiar OpenAI endpoints.
@available(iOS 26.0, macOS 15.0, *)
@MainActor
final class FoundationModelsServer {
    static let shared = FoundationModelsServer()
    
    private let port: UInt16 = 11534
    private var listener: NWListener?
    private var isRunning = false
    #if canImport(FoundationModels)
    private var session: LanguageModelSession?
    #endif
    
    private let httpQueue = DispatchQueue(label: "com.edgeagent.foundationmodels.http", qos: .userInitiated)
    
    private init() {}
    
    // MARK: - Server Lifecycle
    
    var baseURL: String {
        "http://localhost:\(port)"
    }
    
    func start() async throws {
        guard !isRunning else { return }
        
        #if canImport(FoundationModels)
        // Check if Foundation Models is available
        guard SystemLanguageModel.default.isAvailable else {
            Log.agent.warning("Foundation Models not available on this device")
            throw FoundationModelsError.notAvailable
        }
        
        // Create language model session
        session = LanguageModelSession()
        #else
        throw FoundationModelsError.notAvailable
        #endif
        
        // Start HTTP server
        let parameters = NWParameters.tcp
        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        
        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                Log.agent.info("Foundation Models server ready on port \(self.port)")
            case .failed(let error):
                Log.agent.error("Foundation Models server failed: \(error)")
            default:
                break
            }
        }
        
        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }
        
        listener?.start(queue: httpQueue)
        isRunning = true
        Log.agent.info("Foundation Models OpenAI-compatible server started on \(baseURL)")
    }
    
    func stop() {
        listener?.cancel()
        listener = nil
        #if canImport(FoundationModels)
        session = nil
        #endif
        isRunning = false
        Log.agent.info("Foundation Models server stopped")
    }
    
    // MARK: - Connection Handling
    
    private nonisolated func handleConnection(_ connection: NWConnection) {
        connection.start(queue: httpQueue)
        let handler = ConnectionHandler(connection: connection, server: self, queue: httpQueue)
        handler.readMore()
    }
}

// MARK: - Connection Handler

/// Encapsulates per-connection state to satisfy Swift 6 strict concurrency.
/// All access is serialized on the httpQueue, so the mutable buffer is safe.
@available(iOS 26.0, macOS 15.0, *)
private final class ConnectionHandler: @unchecked Sendable {
    private let connection: NWConnection
    private let server: FoundationModelsServer
    private let queue: DispatchQueue
    private var requestBuffer = Data()
    
    init(connection: NWConnection, server: FoundationModelsServer, queue: DispatchQueue) {
        self.connection = connection
        self.server = server
        self.queue = queue
    }
    
    func readMore() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let error = error {
                Log.agent.error("Foundation Models receive error: \(error)")
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
                    // Process request asynchronously
                    let fullRequest = requestBuffer
                    Task { @MainActor [server] in
                        let response = await server.handleHTTPRequest(fullRequest)
                        self.connection.send(content: response, completion: .contentProcessed { _ in
                            self.connection.cancel()
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
}

// MARK: - HTTP Request Handling

@available(iOS 26.0, macOS 15.0, *)
extension FoundationModelsServer {
    
    fileprivate func handleHTTPRequest(_ data: Data) async -> Data {
        guard let requestString = String(data: data, encoding: .utf8) else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid encoding\"}")
        }
        
        // Parse HTTP request line
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
        
        // Route request
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
                    id: "apple-on-device",
                    object: "model",
                    created: Int(Date().timeIntervalSince1970),
                    ownedBy: "apple"
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
        #if canImport(FoundationModels)
        guard let bodyData = body.data(using: .utf8),
              let request = try? JSONDecoder().decode(ChatCompletionRequest.self, from: bodyData) else {
            return httpResponse(status: 400, body: "{\"error\": \"Invalid JSON\"}")
        }
        
        guard let session = session else {
            return httpResponse(status: 500, body: "{\"error\": \"Session not initialized\"}")
        }
        
        // Build prompt from messages
        let prompt = request.messages.map { msg in
            switch msg.role {
            case "system":
                return "[System] \(msg.content)"
            case "assistant":
                return "[Assistant] \(msg.content)"
            default:
                return msg.content
            }
        }.joined(separator: "\n\n")
        
        let isStreaming = request.stream ?? false
        let requestId = "chatcmpl-\(UUID().uuidString.prefix(8))"
        let created = Int(Date().timeIntervalSince1970)
        
        do {
            if isStreaming {
                // Streaming response
                return await handleStreamingResponse(
                    session: session,
                    prompt: prompt,
                    requestId: requestId,
                    created: created
                )
            } else {
                // Non-streaming response
                let response = try await session.respond(to: prompt)
                let responseText = response.content
                
                let chatResponse = ChatCompletionResponse(
                    id: requestId,
                    object: "chat.completion",
                    created: created,
                    model: "apple-on-device",
                    choices: [
                        ChatChoice(
                            index: 0,
                            message: ChatMessage(role: "assistant", content: responseText),
                            finishReason: "stop"
                        )
                    ],
                    usage: nil  // Apple doesn't provide token counts
                )
                
                guard let jsonData = try? JSONEncoder().encode(chatResponse),
                      let jsonString = String(data: jsonData, encoding: .utf8) else {
                    return httpResponse(status: 500, body: "{\"error\": \"Encoding failed\"}")
                }
                
                return httpResponse(status: 200, body: jsonString)
            }
        } catch {
            return httpResponse(status: 500, body: "{\"error\": \"\(error.localizedDescription)\"}")
        }
        #else
        return httpResponse(status: 500, body: "{\"error\": \"Foundation Models not available\"}")
        #endif
    }
    
    #if canImport(FoundationModels)
    private func handleStreamingResponse(
        session: LanguageModelSession,
        prompt: String,
        requestId: String,
        created: Int
    ) async -> Data {
        var chunks: [String] = []
        
        do {
            // Use streaming API
            for try await partial in session.streamResponse(to: prompt) {
                let partialText = partial.content
                let chunk = ChatCompletionChunk(
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: created,
                    model: "apple-on-device",
                    choices: [
                        StreamChoice(
                            index: 0,
                            delta: StreamDelta(role: nil, content: partialText),
                            finishReason: nil
                        )
                    ]
                )
                
                if let jsonData = try? JSONEncoder().encode(chunk),
                   let jsonString = String(data: jsonData, encoding: .utf8) {
                    chunks.append("data: \(jsonString)\n\n")
                }
            }
            
            // Final chunk with finish_reason
            let finalChunk = ChatCompletionChunk(
                id: requestId,
                object: "chat.completion.chunk",
                created: created,
                model: "apple-on-device",
                choices: [
                    StreamChoice(
                        index: 0,
                        delta: StreamDelta(role: nil, content: nil),
                        finishReason: "stop"
                    )
                ]
            )
            
            if let jsonData = try? JSONEncoder().encode(finalChunk),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                chunks.append("data: \(jsonString)\n\n")
            }
            chunks.append("data: [DONE]\n\n")
            
        } catch {
            Log.agent.error("Streaming error: \(error)")
            return httpResponse(status: 500, body: "{\"error\": \"\(error.localizedDescription)\"}")
        }
        
        return httpStreamResponse(chunks: chunks)
    }
    #endif
    
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
    
    private func httpStreamResponse(chunks: [String]) -> Data {
        let body = chunks.joined()
        
        let response = """
        HTTP/1.1 200 OK\r
        Content-Type: text/event-stream\r
        Cache-Control: no-cache\r
        Connection: close\r
        \r
        \(body)
        """
        
        return Data(response.utf8)
    }
}
