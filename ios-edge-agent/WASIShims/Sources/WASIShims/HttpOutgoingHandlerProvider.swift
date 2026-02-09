/// HttpOutgoingHandlerProvider.swift
/// Type-safe WASI import provider for wasi:http/outgoing-handler@0.2.9
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import WASIP2Harness
import OSLog

/// Provides type-safe WASI imports for HTTP outgoing handler interface.
public struct HttpOutgoingHandlerProvider: WASIProvider {
    public static var moduleName: String { "wasi:http/outgoing-handler" }
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:http/outgoing-handler@0.2.9", name: "handle", parameters: [.i32, .i32, .i32, .i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    private let httpManager: any HTTPRequestPerforming
    private let module = "wasi:http/outgoing-handler@0.2.9"
    
    private typealias Sig = MCPSignatures.http_outgoing_handler_0_2_9
    
    public init(resources: ResourceRegistry, httpManager: any HTTPRequestPerforming) {
        self.resources = resources
        self.httpManager = httpManager
    }
    
    public func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        let httpManager = self.httpManager
        
        // handle: (request, has_options, options_handle, ret_ptr) -> ()
        // Returns: result<future-incoming-response, error-code>
        // Memory layout: 40 bytes (24 + 4 * sizeof(ptr) on 32-bit)
        // - offset 0: u8 discriminant (0 = Ok, 1 = Err)
        // - offset 8: i32 handle (if Ok) or u8 error-code discriminant (if Err)
        imports.define(module: module, name: "handle",
            Function(store: store, parameters: Sig.handle.parameters, results: Sig.handle.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                // args[1] = has_options, args[2] = options_handle
                let retPtr = UInt(args[3].i32)
                
                // Zero-initialize full result area (40 bytes) to prevent garbage interpretation
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 40) { buf in
                    for i in 0..<40 { buf[i] = 0 }
                }
                
                guard let request: HTTPOutgoingRequest = resources.get(requestHandle) else {
                    // Write error result - already zero-initialized, just set discriminant
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 1) { buf in
                        buf[0] = 1 // Err discriminant
                    }
                    // Error code at offset 8 is 0 (DnsTimeout) due to zero-init - acceptable default
                    return []
                }
                
                // Build URL from request components
                let scheme = request.scheme ?? "https"
                let authority = request.authority ?? ""
                let path = request.path.isEmpty ? "/" : request.path
                let urlString = "\(scheme)://\(authority)\(path)"
                
                Log.http.info("HTTP handle called for \(request.method) \(urlString)")
                
                guard let url = URL(string: urlString) else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 1) { buf in
                        buf[0] = 1 // Err discriminant
                    }
                    return []
                }
                
                // Get headers from headers handle
                var headers: [(String, String)] = []
                if let fields: HTTPFields = resources.get(request.headersHandle) {
                    headers = fields.entries
                }
                
                // Get body data - prefer direct reference which survives registry drops
                var bodyData: Data? = nil
                if let body = request.outgoingBody {
                    bodyData = body.data
                    Log.http.debug("Body data from direct reference: \(bodyData?.count ?? 0) bytes")
                } else if let bodyHandle = request.outgoingBodyHandle {
                    // Fallback to registry lookup (usually won't work after resource-drop)
                    Log.http.debug("Looking up body by handle: \(bodyHandle)")
                    if let body: HTTPOutgoingBody = resources.get(bodyHandle) {
                        bodyData = body.data
                        Log.http.debug("Body data from registry: \(bodyData?.count ?? 0) bytes")
                    } else {
                        Log.http.warning("Body handle \(bodyHandle) not found in resources")
                    }
                }
                
                // Create future response
                let future = FutureIncomingResponse()
                let futureHandle = resources.register(future)
                
                // Start HTTP request using ephemeral session with completion handler
                // (matches httpManager.performRequest pattern for reliable execution)
                let ephemeralConfig = URLSessionConfiguration.ephemeral
                ephemeralConfig.timeoutIntervalForRequest = 300
                let ephemeralSession = URLSession(configuration: ephemeralConfig)
                
                var urlRequest = URLRequest(url: url)
                urlRequest.httpMethod = request.method
                urlRequest.addValue("close", forHTTPHeaderField: "Connection")
                
                for (key, value) in headers {
                    urlRequest.setValue(value, forHTTPHeaderField: key)
                }
                
                if let body = bodyData {
                    urlRequest.httpBody = body
                }
                
                let task = ephemeralSession.dataTask(with: urlRequest) { data, response, error in
                    defer { ephemeralSession.finishTasksAndInvalidate() }
                    
                    if let error = error {
                        Log.http.error("HTTP request failed: \(error.localizedDescription)")
                        future.error = error.localizedDescription
                        future.signalReady()
                        return
                    }
                    
                    guard let httpResponse = response as? HTTPURLResponse else {
                        future.error = "Invalid response type"
                        future.signalReady()
                        return
                    }
                    
                    Log.http.debug("Response: status=\(httpResponse.statusCode), body=\(data?.count ?? 0) bytes")
                    
                    // Log error response bodies for debugging API errors
                    if httpResponse.statusCode >= 400, let data = data {
                        let bodyStr = String(data: data, encoding: .utf8) ?? "binary"
                        Log.http.error("Error response body: \(bodyStr)")
                    }
                    
                    var headerPairs: [(String, String)] = []
                    for (key, value) in httpResponse.allHeaderFields {
                        if let k = key as? String, let v = value as? String {
                            headerPairs.append((k.lowercased(), v))
                        }
                    }
                    
                    let incomingResponse = HTTPIncomingResponse(
                        status: httpResponse.statusCode,
                        headers: headerPairs,
                        body: data ?? Data()
                    )
                    incomingResponse.streamComplete = true
                    
                    future.response = incomingResponse
                    future.signalReady()
                }
                task.resume()
                
                // Write successful result with future handle at offset 8 (not 4!)
                memory.withUnsafeMutableBufferPointer(offset: retPtr + 8, count: 4) { buf in
                    buf.storeBytes(of: UInt32(bitPattern: futureHandle).littleEndian, toByteOffset: 0, as: UInt32.self)
                }
                
                return []
            }
        )
    }
}
