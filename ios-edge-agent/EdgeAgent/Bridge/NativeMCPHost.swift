import Foundation
import WasmKit
import WasmParser
import OSLog
import Network

/// Native WASM runtime for the MCP shell server using WasmKit.
/// This loads ts-runtime-mcp.wasm and provides shell command execution capabilities.
///
/// Currently stubbed for initial integration - process spawning will be added incrementally.
@MainActor
final class NativeMCPHost: NSObject, ObservableObject, @unchecked Sendable {
    
    static let shared = NativeMCPHost()
    
    // Published state for SwiftUI
    @Published var isReady = false
    @Published var isLoading = false
    
    private var engine: Engine?
    private var store: Store?
    private var instance: Instance?
    
    // Resource registries for WASI handles (shared types from WasmKitTypes.swift)
    private let resources = ResourceRegistry()
    
    // HTTP state management
    private let httpManager = HTTPRequestManager()
    
    // HTTP server for incoming MCP requests
    private var httpListener: Task<Void, Never>?
    private let port: UInt16 = 9293
    
    // Process management via NativeLoaderImpl
    private var loaderImpl: NativeLoaderImpl?
    
    private override init() {
        super.init()
    }
    
    // MARK: - Public API
    
    /// Load and initialize the MCP WASM module
    func load() async throws {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        
        // Get path to WASM file in bundle
        guard let wasmPath = Bundle.main.path(forResource: "WebRuntime/mcp-server-sync/ts-runtime-mcp.core", ofType: "wasm") else {
            Log.mcp.error("MCP WASM module not found in bundle")
            throw WasmKitHostError.wasmNotFound
        }
        
        let wasmData = try Data(contentsOf: URL(fileURLWithPath: wasmPath))
        let module = try parseWasm(bytes: Array(wasmData))
        
        Log.mcp.info("Loaded MCP WASM module: \(wasmData.count) bytes")
        
        // Create engine and store
        engine = Engine()
        store = Store(engine: engine!)
        
        // Build imports for WASI interfaces using type-safe providers
        var imports = Imports()
        
        // Filesystem (wasi_snapshot_preview1) - legacy interface
        SharedWASIImports.registerPreview1(&imports, store: store!, resources: resources)
        
        // Create type-safe providers for WASI interfaces
        let providers: [any WASIProvider] = [
            RandomProvider(),
            ClocksProvider(resources: resources),
            CliProvider(resources: resources),
            IoPollProvider(resources: resources),
            IoErrorProvider(resources: resources),
            IoStreamsProvider(resources: resources),
            SocketsProvider(resources: resources),
            HttpOutgoingHandlerProvider(resources: resources, httpManager: httpManager),
            HttpTypesProvider(resources: resources, httpManager: httpManager),
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
        
        // Module Loader (MCP-specific) - not a standard WASI interface
        loaderImpl = NativeLoaderImpl(resources: resources)
        let loaderProvider = ModuleLoaderProvider(loader: loaderImpl!)
        loaderProvider.register(into: &imports, store: store!)
        
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
    func startServer() async throws {
        guard isReady else {
            throw WasmKitHostError.notLoaded
        }
        
        Log.mcp.info("Starting MCP HTTP server on port \(port)")
        
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
        
        Log.mcp.info("MCP HTTP server listening on port \(port)")
    }
    
    private func handleConnection(_ connection: NWConnection, on queue: DispatchQueue) {
        connection.start(queue: queue)
        
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self, let data = data else {
                connection.cancel()
                return
            }
            
            // Use DispatchQueue for request handling to avoid Swift Concurrency cooperative pool
            queue.async {
                // Run synchronously to avoid any cooperative executor dependencies
                self.handleHTTPRequestSync(data: data, connection: connection)
            }
        }
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
        // Parse HTTP request
        guard let requestString = String(data: data, encoding: .utf8) else {
            throw WasmKitHostError.invalidString
        }
        
        Log.mcp.debug("Received request: \(requestString.prefix(200))")
        
        // For now, return a stub response
        // TODO: Call wasi:http/incoming-handler@0.2.9#handle export
        let responseBody = """
        {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"run_command","description":"Execute a shell command (stub)","inputSchema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]}}
        """
        
        let response = """
        HTTP/1.1 200 OK\r
        Content-Type: application/json\r
        Content-Length: \(responseBody.utf8.count)\r
        Connection: close\r
        \r
        \(responseBody)
        """
        
        return response.data(using: .utf8)!
    }

    /// Registers HTTP imports that are host-specific (not shared with NativeAgentHost)
    /// Common HTTP client imports are now in SharedWASIImports.registerHttpClient()
    private func registerHttpImports(_ imports: inout Imports) {
        guard let store = store else { return }
        let httpModule = "wasi:http/types@0.2.9"
        
        // =============================================================================
        // OUTGOING HTTP HANDLER - Uses httpManager to perform requests
        // =============================================================================
        
        imports.define(module: "wasi:http/outgoing-handler@0.2.9", name: "handle",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                            buffer[0] = 1  // Err
                        }
                    }
                    return []
                }
                
                // Build URL
                let scheme = request.scheme.isEmpty ? "https" : request.scheme
                let authority = request.authority.isEmpty ? "localhost" : request.authority
                let path = request.path.isEmpty ? "/" : request.path
                let urlString = "\(scheme)://\(authority)\(path)"
                
                // Get headers
                var headers: [(String, String)] = []
                if let fields: HTTPFields = self.resources.get(request.headersHandle) {
                    headers = fields.entries
                }
                
                // Get body
                var body: Data? = nil
                if let bodyHandle = request.outgoingBodyHandle,
                   let outgoingBody: HTTPOutgoingBody = self.resources.get(bodyHandle) {
                    body = outgoingBody.data
                }
                
                // Create future and start async request using existing API
                let future = FutureIncomingResponse()
                let futureHandle = self.resources.register(future)
                
                self.httpManager.performRequest(
                    method: request.method,
                    url: urlString,
                    headers: headers,
                    body: body,
                    future: future,
                    resources: self.resources
                )
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                    buffer[0] = 0  // Ok
                    buffer.storeBytes(of: UInt32(bitPattern: futureHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // =============================================================================
        // FUTURE-INCOMING-RESPONSE - Polling for async HTTP responses
        // =============================================================================
        
        imports.define(module: httpModule, name: "[method]future-incoming-response.subscribe",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                let futureHandle = Int32(bitPattern: args[0].i32)
                if let future: FutureIncomingResponse = self?.resources.get(futureHandle) {
                    let pollable = FuturePollable(future: future)
                    let pollableHandle = self?.resources.register(pollable) ?? 0
                    return [.i32(UInt32(bitPattern: pollableHandle))]
                }
                return [.i32(0)]
            }
        )
        
        imports.define(module: httpModule, name: "[method]future-incoming-response.get",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                let futureHandle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                if let future: FutureIncomingResponse = self?.resources.get(futureHandle),
                   let response = future.response {
                    let responseHandle = self?.resources.register(response) ?? 0
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        buffer[0] = 1  // Some
                        buffer[1] = 0  // Ok
                        buffer.storeBytes(of: UInt32(bitPattern: responseHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        buffer[0] = 0  // None
                    }
                }
                return []
            }
        )
        
        // =============================================================================
        // HTTP SERVER IMPORTS - For MCP server handling incoming requests
        // =============================================================================
        
        // [constructor]outgoing-response
        imports.define(module: httpModule, name: "[constructor]outgoing-response",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                let headersHandle = Int32(bitPattern: args[0].i32)
                let response = HTTPOutgoingResponseResource(headersHandle: headersHandle)
                let handle = self?.resources.register(response) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]outgoing-response.set-status-code
        imports.define(module: httpModule, name: "[method]outgoing-response.set-status-code",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { [weak self] _, args in
                let responseHandle = Int32(bitPattern: args[0].i32)
                let statusCode = args[1].i32
                if let response: HTTPOutgoingResponseResource = self?.resources.get(responseHandle) {
                    response.statusCode = Int(statusCode)
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-response.body
        imports.define(module: httpModule, name: "[method]outgoing-response.body",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                let responseHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                if let response: HTTPOutgoingResponseResource = self?.resources.get(responseHandle) {
                    let body = HTTPOutgoingBody()
                    let bodyHandle = self?.resources.register(body) ?? 0
                    response.bodyHandle = bodyHandle
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer[0] = 0
                        buffer.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer[0] = 1
                    }
                }
                return []
            }
        )
        
        // [static]response-outparam.set - sets the response for a response-outparam
        // Parameters: outparam handle, result discriminant, ok/err pointer, ok/err len (if error string)
        imports.define(module: httpModule, name: "[static]response-outparam.set",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: []) { [weak self] _, args in
                let outparamHandle = Int32(bitPattern: args[0].i32)
                let isOk = args[1].i32 == 0
                let responseOrErrorHandle = Int32(bitPattern: args[2].i32)
                
                if let outparam: ResponseOutparam = self?.resources.get(outparamHandle) {
                    if isOk {
                        // Set the response
                        if let response: HTTPOutgoingResponseResource = self?.resources.get(responseOrErrorHandle) {
                            outparam.response = response
                            outparam.responseSet = true
                            Log.mcp.debug("response-outparam.set: response set with status \(response.statusCode)")
                        }
                    } else {
                        // Set the error
                        outparam.error = "HTTP response error"
                        outparam.responseSet = true
                        Log.mcp.debug("response-outparam.set: error set")
                    }
                } else {
                    Log.mcp.warning("response-outparam.set: invalid outparam handle \(outparamHandle)")
                }
                return []
            }
        )
        
        // [method]incoming-request.headers - returns a Fields handle with request headers
        imports.define(module: httpModule, name: "[method]incoming-request.headers",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                if let request: HTTPIncomingRequest = self?.resources.get(requestHandle) {
                    let handle = self?.resources.register(request.headers) ?? 0
                    return [.i32(UInt32(bitPattern: handle))]
                }
                // If no request found, return empty fields handle
                let fields = HTTPFields()
                let handle = self?.resources.register(fields) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]incoming-request.path-with-query - returns option<string>
        imports.define(module: httpModule, name: "[method]incoming-request.path-with-query",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                if let request: HTTPIncomingRequest = self?.resources.get(requestHandle),
                   let path = request.pathWithQuery {
                    // Allocate string in WASM memory
                    if let reallocFn = caller.instance?.exports[function: "cabi_realloc"] {
                        let pathBytes = Array(path.utf8)
                        let stringPtr = try? reallocFn([.i32(0), .i32(0), .i32(1), .i32(UInt32(pathBytes.count))])
                        if let ptr = stringPtr?.first?.i32 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: pathBytes.count) { buffer in
                                for (i, byte) in pathBytes.enumerated() {
                                    buffer[i] = byte
                                }
                            }
                            memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 12) { buffer in
                                buffer[0] = 1  // Some
                                buffer.storeBytes(of: UInt32(ptr).littleEndian, toByteOffset: 4, as: UInt32.self)
                                buffer.storeBytes(of: UInt32(pathBytes.count).littleEndian, toByteOffset: 8, as: UInt32.self)
                            }
                            return []
                        }
                    }
                }
                // No path available - return None
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 12) { buffer in
                    buffer[0] = 0  // None
                }
                return []
            }
        )
        
        // [method]incoming-request.consume - returns result<incoming-body, error>
        imports.define(module: httpModule, name: "[method]incoming-request.consume",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                if let request: HTTPIncomingRequest = self?.resources.get(requestHandle),
                   !request.bodyConsumed {
                    request.bodyConsumed = true
                    // Create incoming body with the request body
                    let incomingBody = HTTPIncomingBody(data: request.body)
                    let bodyHandle = self?.resources.register(incomingBody) ?? 0
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer[0] = 0  // Ok
                        buffer.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    // Already consumed or invalid request - return error
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer[0] = 1  // Error
                    }
                }
                return []
            }
        )
        
        // HTTP Server resource drops
        imports.define(module: httpModule, name: "[resource-drop]outgoing-response",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]response-outparam",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: httpModule, name: "[resource-drop]incoming-request",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
}
