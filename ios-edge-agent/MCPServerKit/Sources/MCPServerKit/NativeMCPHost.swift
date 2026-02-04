import Foundation
import WasmKit
import WasmParser
import OSLog
import Network
import WASIP2Harness
import WASIShims

/// Native WASM runtime for MCP server using WasmKit.
/// This loads a WASM module and routes HTTP requests to its wasi:http/incoming-handler.
///
/// Usage:
/// 1. Create instance with WASM module path
/// 2. Load the module: `await host.load(wasmPath:)`
/// 3. Start server: `await host.startServer()`
@MainActor
public final class NativeMCPHost: NSObject, ObservableObject, @unchecked Sendable {
    
    public static let shared = NativeMCPHost()
    
    // Published state for SwiftUI
    @Published public var isReady = false
    @Published public var isLoading = false
    
    private var engine: Engine?
    private var store: Store?
    private var instance: Instance?
    
    // Resource registries for WASI handles (shared types from WasmKitTypes.swift)
    private let resources = ResourceRegistry()
    
    // HTTP state management
    private let httpManager = HTTPRequestManager()
    
    // HTTP server for incoming MCP requests
    private var httpListener: Task<Void, Never>?
    public var port: UInt16 = 9293
    
    // Process management via NativeLoaderImpl
    private var loaderImpl: NativeLoaderImpl?
    
    // Configurable filesystem
    public var filesystem: SandboxFilesystem = SandboxFilesystem.shared
    
    public override init() {
        super.init()
    }
    
    // MARK: - Public API
    
    /// Load and initialize the MCP WASM module from bundle
    public func load() async throws {
        // Get path to WASM file in bundle
        guard let wasmPath = Bundle.main.path(forResource: "WebRuntime/mcp-server-sync/ts-runtime-mcp.core", ofType: "wasm") else {
            Log.mcp.error("MCP WASM module not found in bundle")
            throw WasmKitHostError.wasmNotFound
        }
        try await loadWasm(from: wasmPath)
    }
    
    /// Load and initialize a WASM module from a specific path
    public func loadWasm(from path: String) async throws {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        
        let wasmData = try Data(contentsOf: URL(fileURLWithPath: path))
        let module = try parseWasm(bytes: Array(wasmData))
        
        Log.mcp.info("Loaded MCP WASM module: \(wasmData.count) bytes")
        
        // Create engine and store
        engine = Engine()
        store = Store(engine: engine!)
        
        // Build imports for WASI interfaces using type-safe providers
        var imports = Imports()
        
        // Create Module Loader implementation (needed by ModuleLoaderProvider)
        loaderImpl = NativeLoaderImpl(resources: resources)
        
        // Create type-safe providers for ALL WASI interfaces including MCP-specific
        let providers: [any WASIProvider] = [
            Preview1Provider(resources: resources, filesystem: filesystem),
            RandomProvider(),
            ClocksProvider(resources: resources),
            CliProvider(resources: resources),
            IoPollProvider(resources: resources),
            IoErrorProvider(resources: resources),
            IoStreamsProvider(resources: resources),
            SocketsProvider(resources: resources),
            HttpOutgoingHandlerProvider(resources: resources, httpManager: httpManager),
            HttpTypesProvider(resources: resources, httpManager: httpManager),
            ModuleLoaderProvider(loader: loaderImpl!),
        ]
        
        // Validate providers against WASM module requirements BEFORE instantiation
        let validationResult = WASIProviderValidator.validate(module: module, providers: providers)
        if !validationResult.isValid {
            Log.mcp.warning(" Missing WASI imports: \(validationResult.missingList.joined(separator: ", "))")
        }
        
        // Register all providers
        for provider in providers {
            provider.register(into: &imports, store: store!)
        }
        
        // Log required imports count for debugging
        Log.mcp.info("Module requires \(module.imports.count) imports")
        
        // Instantiate module - WasmKit will error with specific missing import name
        do {
            instance = try module.instantiate(store: store!, imports: imports)
            Log.mcp.info("MCP WASM module instantiated successfully")
            isReady = true
        } catch {
            // Log the full error which includes the missing import module and name
            Log.mcp.error("MCP WASM instantiation failed: \(error)")
            Log.mcp.error("Error description: \(String(describing: error))")
            throw error
        }
    }
    
    /// Start the HTTP server to receive MCP requests
    public func startServer() async throws {
        guard isReady else {
            throw WasmKitHostError.notLoaded
        }
        
        Log.mcp.info("Starting MCP HTTP server on port \(self.port)")
        
        // Create dedicated queue for MCP server - separate from DispatchQueue.global()
        // This prevents thread pool exhaustion from semaphore.wait() blocking all global threads
        let mcpServerQueue = DispatchQueue(label: "com.edgeagent.mcp.server", qos: .userInitiated, attributes: .concurrent)
        
        // For now, we use a simple TCP server via NWListener
        let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        
        listener.stateUpdateHandler = { state in
            Log.mcp.debug("MCP Server state: \(String(describing: state))")
        }
        
        listener.newConnectionHandler = { [weak self] connection in
            guard let self = self else { return }
            // Run on dedicated MCP queue to avoid thread pool exhaustion
            mcpServerQueue.async {
                self.handleConnection(connection, on: mcpServerQueue)
            }
        }
        
        listener.start(queue: mcpServerQueue)
        
        Log.mcp.info("MCP HTTP server listening on port \(self.port)")
    }
    
    private func handleConnection(_ connection: NWConnection, on queue: DispatchQueue) {
        connection.start(queue: queue)
        
        // Buffer to accumulate request data until we have full body
        var requestBuffer = Data()
        
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
                guard let self = self else {
                    connection.cancel()
                    return
                }
                
                if let error = error {
                    Log.mcp.error("Receive error: \(error)")
                    connection.cancel()
                    return
                }
                
                if let data = data {
                    requestBuffer.append(data)
                }
                
                // Check if we have a complete HTTP request
                let headerSeparator = Data("\r\n\r\n".utf8)
                if let headerEndRange = requestBuffer.range(of: headerSeparator) {
                    let headerData = requestBuffer[..<headerEndRange.lowerBound]
                    
                    // Parse Content-Length from headers (ASCII-safe)
                    var contentLength = 0
                    if let headersString = String(data: headerData, encoding: .utf8) {
                        for line in headersString.split(separator: "\r\n") {
                            if line.lowercased().hasPrefix("content-length:") {
                                let value = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                                contentLength = Int(value) ?? 0
                            }
                        }
                    }
                    
                    // Calculate body length in BYTES
                    let bodyStartIndex = headerEndRange.upperBound
                    let currentBodyLength = requestBuffer.count - bodyStartIndex
                    
                    // If we have the full body, process the request
                    if currentBodyLength >= contentLength {
                        queue.async {
                            self.handleHTTPRequestSync(data: requestBuffer, connection: connection)
                        }
                        return
                    }
                }
                
                // Need more data or error
                if error != nil || isComplete {
                    connection.cancel()
                } else {
                    readMore()
                }
            }
        }
        
        readMore()
    }

    
    /// Synchronous HTTP request handler - avoids cooperative thread pool entirely
    private func handleHTTPRequestSync(data: Data, connection: NWConnection) {
        do {
            // Call synchronous handler directly - no async/await needed
            let response = try handleHTTPRequestDirect(data: data)
            
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        } catch {
            Log.mcp.error("Request handling error: \(error)")
            let errorResponse = "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n".data(using: .utf8)!
            connection.send(content: errorResponse, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
    
    /// Direct synchronous HTTP request handler (no async/await)
    private func handleHTTPRequestDirect(data: Data) throws -> Data {
        guard let instance = instance else {
            throw WasmKitHostError.notLoaded
        }
        
        // Parse HTTP request
        guard let requestString = String(data: data, encoding: .utf8) else {
            throw WasmKitHostError.invalidString
        }
        
        Log.mcp.debug("Received request: \(requestString.prefix(200))")
        
        // Parse HTTP request line and headers
        let lines = requestString.components(separatedBy: "\r\n")
        guard lines.count >= 1 else {
            throw WasmKitHostError.invalidString
        }
        
        // Parse request line: "POST / HTTP/1.1"
        let requestLine = lines[0].components(separatedBy: " ")
        let method = requestLine.count > 0 ? requestLine[0] : "GET"
        let path = requestLine.count > 1 ? requestLine[1] : "/"
        
        // Parse headers until empty line
        var headers = HTTPFields()
        var bodyStartIndex = 1
        for (index, line) in lines.dropFirst().enumerated() {
            if line.isEmpty {
                bodyStartIndex = index + 2 // +1 for dropFirst, +1 for empty line
                break
            }
            if let colonIndex = line.firstIndex(of: ":") {
                let name = String(line[..<colonIndex]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
                headers.append(name: name, value: value)
            }
        }
        
        // Get body
        var body = Data()
        if bodyStartIndex < lines.count {
            let bodyString = lines[bodyStartIndex...].joined(separator: "\r\n")
            body = bodyString.data(using: .utf8) ?? Data()
        }
        
        // Create IncomingRequest resource
        let incomingRequest = HTTPIncomingRequest(method: method, path: path, headers: headers, body: body)
        let requestHandle = resources.register(incomingRequest)
        
        // Create ResponseOutparam resource  
        let responseOutparam = ResponseOutparam()
        let outparamHandle = resources.register(responseOutparam)
        
        Log.mcp.debug("Calling WASM incoming-handler with request=\(requestHandle), outparam=\(outparamHandle)")
        
        // Get the WASM incoming-handler export
        guard let handleFn = instance.exports[function: "wasi:http/incoming-handler@0.2.9#handle"] else {
            Log.mcp.error("incoming-handler export not found")
            throw WasmKitHostError.invalidString
        }
        
        // Call the WASM handler: handle(request: i32, response-out: i32)
        do {
            _ = try handleFn([.i32(UInt32(bitPattern: requestHandle)), .i32(UInt32(bitPattern: outparamHandle))])
        } catch {
            Log.mcp.error("WASM handler failed: \(error)")
            throw error
        }
        
        // Read response from ResponseOutparam
        guard responseOutparam.responseSet, let response = responseOutparam.response else {
            Log.mcp.error("ResponseOutparam not set after handler")
            let errorBody = """
            {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error: no response from handler"}}
            """
            return formatHTTPResponse(statusCode: 500, body: errorBody)
        }
        
        // Get response body - prefer direct reference which survives registry drops
        var responseBody = Data()
        if let body = response.outgoingBody {
            responseBody = body.getData()
            Log.mcp.debug("Body data from direct reference: \(responseBody.count) bytes")
        } else if let bodyHandle = response.bodyHandle,
           let outgoingBody: HTTPOutgoingBody = resources.get(bodyHandle) {
            // Fallback to registry lookup
            responseBody = outgoingBody.getData()
            Log.mcp.debug("Body data from registry: \(responseBody.count) bytes")
        }
        
        let responseBodyString = String(data: responseBody, encoding: .utf8) ?? ""
        Log.mcp.debug("WASM response: status=\(response.statusCode), body=\(responseBodyString.prefix(200))")
        
        return formatHTTPResponse(statusCode: response.statusCode, body: responseBodyString)
    }
    
    /// Format an HTTP response
    private func formatHTTPResponse(statusCode: Int, body: String) -> Data {
        let response = """
        HTTP/1.1 \(statusCode) OK\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """
        return response.data(using: .utf8)!
    }
}

