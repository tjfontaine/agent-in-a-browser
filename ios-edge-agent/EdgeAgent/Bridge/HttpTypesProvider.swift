/// HttpTypesProvider.swift
/// Type-safe WASI import provider for wasi:http/types@0.2.9
///
/// Uses MCPSignatures constants for ABI-correct function signatures.
/// This includes both HTTP client types and HTTP server types.

import WasmKit
import OSLog

/// Provides type-safe WASI imports for HTTP types interface.
/// Used for both HTTP client (outgoing requests) and HTTP server (incoming requests).
struct HttpTypesProvider: WASIProvider {
    
    static var moduleName: String { "wasi:http/types@0.2.9" }
    
    private let resources: ResourceRegistry
    private let httpManager: HTTPRequestManager
    private let module = "wasi:http/types@0.2.9"
    
    private typealias Sig = MCPSignatures.http_types_0_2_9
    
    init(resources: ResourceRegistry, httpManager: HTTPRequestManager) {
        self.resources = resources
        self.httpManager = httpManager
    }
    
    /// All imports declared and registered by this provider
    var declaredImports: [WASIImportDeclaration] {
        let m = Self.moduleName
        return [
            // Constructors
            WASIImportDeclaration(module: m, name: "[constructor]fields", parameters: [], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[constructor]request-options", parameters: [], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[constructor]outgoing-request", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[constructor]outgoing-response", parameters: [.i32, .i32], results: [.i32]),
            // Fields methods
            WASIImportDeclaration(module: m, name: "[method]fields.append", parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[method]fields.set", parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[method]fields.entries", parameters: [.i32, .i32], results: []),
            // Outgoing request methods
            WASIImportDeclaration(module: m, name: "[method]outgoing-request.set-method", parameters: [.i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]outgoing-request.set-scheme", parameters: [.i32, .i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]outgoing-request.set-authority", parameters: [.i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]outgoing-request.set-path-with-query", parameters: [.i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]outgoing-request.body", parameters: [.i32, .i32], results: []),
            // Outgoing body
            WASIImportDeclaration(module: m, name: "[method]outgoing-body.write", parameters: [.i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[static]outgoing-body.finish", parameters: [.i32, .i32, .i32, .i32], results: []),
            // Incoming response
            WASIImportDeclaration(module: m, name: "[method]incoming-response.status", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]incoming-response.headers", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]incoming-response.consume", parameters: [.i32, .i32], results: []),
            // Future response
            WASIImportDeclaration(module: m, name: "[method]future-incoming-response.subscribe", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]future-incoming-response.get", parameters: [.i32, .i32], results: []),
            // Incoming body
            WASIImportDeclaration(module: m, name: "[method]incoming-body.stream", parameters: [.i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[static]incoming-body.finish", parameters: [.i32, .i32], results: []),
            // HTTP server
            WASIImportDeclaration(module: m, name: "[method]incoming-request.headers", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[method]incoming-request.path-with-query", parameters: [.i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[method]incoming-request.consume", parameters: [.i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[method]outgoing-response.body", parameters: [.i32, .i32], results: []),
            WASIImportDeclaration(module: m, name: "[method]outgoing-response.set-status-code", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: m, name: "[static]response-outparam.set", parameters: [.i32, .i32, .i32, .i32, .i64, .i32, .i32, .i32, .i32], results: []),
            // Resource drops
            WASIImportDeclaration(module: m, name: "[resource-drop]fields", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]outgoing-request", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]outgoing-body", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]incoming-response", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]future-incoming-response", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]incoming-body", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]future-trailers", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]outgoing-response", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]response-outparam", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]incoming-request", parameters: [.i32], results: []),
            WASIImportDeclaration(module: m, name: "[resource-drop]request-options", parameters: [.i32], results: []),
        ]
    }
    
    func register(into imports: inout Imports, store: Store) {
        registerFieldsConstructor(&imports, store: store)
        registerFieldsMethods(&imports, store: store)
        registerRequestOptions(&imports, store: store)
        registerOutgoingRequest(&imports, store: store)
        registerOutgoingBody(&imports, store: store)
        registerIncomingResponse(&imports, store: store)
        registerFutureIncomingResponse(&imports, store: store)
        registerIncomingBody(&imports, store: store)
        registerHttpServer(&imports, store: store)
        registerResourceDrops(&imports, store: store)
    }
    
    // MARK: - Fields Constructor & Methods
    
    private func registerFieldsConstructor(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [constructor]fields: () -> i32
        imports.define(module: module, name: "[constructor]fields",
            Function(store: store, parameters: Sig.constructorfields.parameters, results: Sig.constructorfields.results) { _, _ in
                let fields = HTTPFields()
                let handle = resources.register(fields)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
    }
    
    // MARK: - Request Options
    
    private func registerRequestOptions(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [constructor]request-options: () -> i32
        imports.define(module: module, name: "[constructor]request-options",
            Function(store: store, parameters: [], results: [.i32]) { _, _ in
                let options = HTTPRequestOptions()
                let handle = resources.register(options)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
    }
    
    private func registerFieldsMethods(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [method]fields.append: (handle, key_ptr, key_len, val_ptr, val_len, ret_ptr) -> ()
        imports.define(module: module, name: "[method]fields.append",
            Function(store: store, parameters: Sig.methodfields_append.parameters, results: Sig.methodfields_append.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let keyPtr = UInt(args[1].i32), keyLen = Int(args[2].i32)
                let valPtr = UInt(args[3].i32), valLen = Int(args[4].i32)
                // ret_ptr at args[5] for result
                
                let key = memory.readString(offset: keyPtr, length: keyLen) ?? ""
                let value = memory.readString(offset: valPtr, length: valLen) ?? ""
                
                if let fields: HTTPFields = resources.get(handle) {
                    fields.append(name: key, value: value)
                }
                return []
            }
        )
        
        // [method]fields.set: (handle, key_ptr, key_len, val_ptr, val_len, ret_ptr) -> ()
        imports.define(module: module, name: "[method]fields.set",
            Function(store: store, parameters: Sig.methodfields_set.parameters, results: Sig.methodfields_set.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let keyPtr = UInt(args[1].i32), keyLen = Int(args[2].i32)
                let valPtr = UInt(args[3].i32), valLen = Int(args[4].i32)
                
                let key = memory.readString(offset: keyPtr, length: keyLen) ?? ""
                let value = memory.readString(offset: valPtr, length: valLen) ?? ""
                
                if let fields: HTTPFields = resources.get(handle) {
                    fields.set(name: key, value: value)
                }
                return []
            }
        )
        
        // [method]fields.entries: (handle, ret_ptr) -> ()
        // Returns list<tuple<field-name, field-value>> where field-name is string, field-value is list<u8>
        // Each tuple is 16 bytes: (name_ptr:4, name_len:4, value_ptr:4, value_len:4)
        imports.define(module: module, name: "[method]fields.entries",
            Function(store: store, parameters: Sig.methodfields_entries.parameters, results: Sig.methodfields_entries.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                guard let reallocFn = caller.instance?.exports[function: "cabi_realloc"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let fields: HTTPFields = resources.get(handle) {
                    let entries = fields.entries
                    
                    if entries.isEmpty {
                        // Empty list: ptr=0, len=0
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                            for i in 0..<8 { buf[i] = 0 }
                        }
                        return []
                    }
                    
                    // Allocate list of tuples: 16 bytes per entry
                    let listSize = entries.count * 16
                    guard let listResult = try? reallocFn([.i32(0), .i32(0), .i32(4), .i32(UInt32(listSize))]),
                          let listPtr = listResult.first?.i32 else {
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                            for i in 0..<8 { buf[i] = 0 }
                        }
                        return []
                    }
                    
                    // Write each entry tuple
                    for (i, (name, value)) in entries.enumerated() {
                        let nameBytes = Array(name.utf8)
                        let valueBytes = Array(value.utf8)
                        
                        // Allocate name string
                        var namePtr: UInt32 = 0
                        if !nameBytes.isEmpty,
                           let nameResult = try? reallocFn([.i32(0), .i32(0), .i32(1), .i32(UInt32(nameBytes.count))]),
                           let np = nameResult.first?.i32 {
                            namePtr = np
                            memory.withUnsafeMutableBufferPointer(offset: UInt(np), count: nameBytes.count) { buf in
                                for (j, byte) in nameBytes.enumerated() { buf[j] = byte }
                            }
                        }
                        
                        // Allocate value bytes
                        var valuePtr: UInt32 = 0
                        if !valueBytes.isEmpty,
                           let valueResult = try? reallocFn([.i32(0), .i32(0), .i32(1), .i32(UInt32(valueBytes.count))]),
                           let vp = valueResult.first?.i32 {
                            valuePtr = vp
                            memory.withUnsafeMutableBufferPointer(offset: UInt(vp), count: valueBytes.count) { buf in
                                for (j, byte) in valueBytes.enumerated() { buf[j] = byte }
                            }
                        }
                        
                        // Write tuple at list[i]: (name_ptr, name_len, value_ptr, value_len)
                        let tupleOffset = UInt(listPtr) + UInt(i * 16)
                        memory.withUnsafeMutableBufferPointer(offset: tupleOffset, count: 16) { buf in
                            buf.storeBytes(of: namePtr.littleEndian, toByteOffset: 0, as: UInt32.self)
                            buf.storeBytes(of: UInt32(nameBytes.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                            buf.storeBytes(of: valuePtr.littleEndian, toByteOffset: 8, as: UInt32.self)
                            buf.storeBytes(of: UInt32(valueBytes.count).littleEndian, toByteOffset: 12, as: UInt32.self)
                        }
                    }
                    
                    // Write list (ptr, len) to return pointer
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf.storeBytes(of: listPtr.littleEndian, toByteOffset: 0, as: UInt32.self)
                        buf.storeBytes(of: UInt32(entries.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    // No fields found - return empty list
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        for i in 0..<8 { buf[i] = 0 }
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Outgoing Request
    
    private func registerOutgoingRequest(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [constructor]outgoing-request: (headers_handle) -> i32
        imports.define(module: module, name: "[constructor]outgoing-request",
            Function(store: store, parameters: Sig.constructoroutgoing_request.parameters, results: Sig.constructoroutgoing_request.results) { _, args in
                let headersHandle = args[0].i32
                let request = HTTPOutgoingRequest(headers: headersHandle)
                let handle = resources.register(request)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]outgoing-request.set-method: (handle, discriminant, str_ptr, str_len) -> i32
        imports.define(module: module, name: "[method]outgoing-request.set-method",
            Function(store: store, parameters: Sig.methodoutgoing_request_set_method.parameters, results: Sig.methodoutgoing_request_set_method.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(1)] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let methodDisc = args[1].i32
                let strPtr = UInt(args[2].i32), strLen = Int(args[3].i32)
                
                if let request: HTTPOutgoingRequest = resources.get(handle) {
                    request.method = Self.methodFromDiscriminant(methodDisc, memory: memory, ptr: strPtr, len: strLen)
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-request.set-scheme: (handle, has_scheme, discriminant, str_ptr, str_len) -> i32
        imports.define(module: module, name: "[method]outgoing-request.set-scheme",
            Function(store: store, parameters: Sig.methodoutgoing_request_set_scheme.parameters, results: Sig.methodoutgoing_request_set_scheme.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(1)] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let hasScheme = args[1].i32 != 0
                let schemeDisc = args[2].i32
                let strPtr = UInt(args[3].i32), strLen = Int(args[4].i32)
                
                if let request: HTTPOutgoingRequest = resources.get(handle) {
                    if hasScheme {
                        request.scheme = schemeDisc == 0 ? "http" :
                                        schemeDisc == 1 ? "https" :
                                        (memory.readString(offset: strPtr, length: strLen) ?? "https")
                    }
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-request.set-authority: (handle, has_auth, str_ptr, str_len) -> i32
        imports.define(module: module, name: "[method]outgoing-request.set-authority",
            Function(store: store, parameters: Sig.methodoutgoing_request_set_authority.parameters, results: Sig.methodoutgoing_request_set_authority.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(1)] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let hasAuth = args[1].i32 != 0
                let strPtr = UInt(args[2].i32), strLen = Int(args[3].i32)
                
                if let request: HTTPOutgoingRequest = resources.get(handle) {
                    if hasAuth {
                        request.authority = memory.readString(offset: strPtr, length: strLen) ?? ""
                    }
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-request.set-path-with-query: (handle, has_path, str_ptr, str_len) -> i32
        imports.define(module: module, name: "[method]outgoing-request.set-path-with-query",
            Function(store: store, parameters: Sig.methodoutgoing_request_set_path_with_query.parameters, results: Sig.methodoutgoing_request_set_path_with_query.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(1)] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let hasPath = args[1].i32 != 0
                let strPtr = UInt(args[2].i32), strLen = Int(args[3].i32)
                
                if let request: HTTPOutgoingRequest = resources.get(handle) {
                    if hasPath {
                        request.path = memory.readString(offset: strPtr, length: strLen) ?? "/"
                    }
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-request.body: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]outgoing-request.body",
            Function(store: store, parameters: Sig.methodoutgoing_request_body.parameters, results: Sig.methodoutgoing_request_body.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                Log.http.debug("outgoing-request.body called with handle=\(handle)")
                
                if let request: HTTPOutgoingRequest = resources.get(handle) {
                    if request.outgoingBodyHandle == nil {
                        let body = HTTPOutgoingBody()
                        let bodyHandle = resources.register(body)
                        request.outgoingBodyHandle = bodyHandle
                        request.outgoingBody = body  // Store direct reference
                        Log.http.debug("Registered body with handle=\(bodyHandle), resources=\(ObjectIdentifier(resources))")
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                            buf[0] = 0 // Ok
                            buf.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                        }
                    } else {
                        Log.http.debug("Body already retrieved: \(request.outgoingBodyHandle!)")
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                            buf[0] = 1 // Error - already retrieved
                        }
                    }
                } else {
                    Log.http.warning("Request handle \(handle) not found!")
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Outgoing Body
    
    private func registerOutgoingBody(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [method]outgoing-body.write: (handle, ret_ptr) -> ()
        // Returns output-stream handle for writing body data
        imports.define(module: module, name: "[method]outgoing-body.write",
            Function(store: store, parameters: Sig.methodoutgoing_body_write.parameters, results: Sig.methodoutgoing_body_write.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                Log.mcp.debug("[method]outgoing-body.write: body handle=\(handle)")
                
                if let body: HTTPOutgoingBody = resources.get(handle) {
                    // Return the body handle itself as the stream handle
                    // The body acts as the stream for write operations
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                        buf.storeBytes(of: UInt32(bitPattern: handle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                    Log.mcp.debug("[method]outgoing-body.write: returning stream handle=\(handle)")
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                    Log.mcp.warning("[method]outgoing-body.write: invalid body handle \(handle)")
                }
                return []
            }
        )
        
        // [static]outgoing-body.finish: (handle, has_trailers, trailers_handle, ret_ptr) -> ()
        // Returns: result<_, error-code> - requires 40 bytes (24 + 4 * sizeof(ptr) on 32-bit)
        imports.define(module: module, name: "[static]outgoing-body.finish",
            Function(store: store, parameters: Sig.staticoutgoing_body_finish.parameters, results: Sig.staticoutgoing_body_finish.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                // args[1] = has_trailers, args[2] = trailers_handle
                let retPtr = UInt(args[3].i32)
                
                Log.mcp.debug("[static]outgoing-body.finish: body handle=\(handle)")
                
                // Zero-initialize full result area (40 bytes) to prevent garbage interpretation
                // Layout: byte 0 = Ok/Err discriminant, bytes 8+ = error-code if Err
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 40) { buf in
                    for i in 0..<40 { buf[i] = 0 }
                }
                
                // Mark body as finished - we always succeed
                if let _: HTTPOutgoingBody = resources.get(handle) {
                    // Already zero-initialized as Ok (discriminant = 0)
                } else {
                    // Body handle not found - still return Ok to avoid error code interpretation issues
                    // The body was already consumed/finished, which is fine
                }
                return []
            }
        )

    }
    
    // MARK: - Incoming Response
    
    private func registerIncomingResponse(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [method]incoming-response.status: (handle) -> i32
        imports.define(module: module, name: "[method]incoming-response.status",
            Function(store: store, parameters: Sig.methodincoming_response_status.parameters, results: Sig.methodincoming_response_status.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                if let response: HTTPIncomingResponse = resources.get(handle) {
                    return [.i32(UInt32(response.status))]
                }
                return [.i32(0)]
            }
        )
        
        // [method]incoming-response.headers: (handle) -> i32
        imports.define(module: module, name: "[method]incoming-response.headers",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                if let response: HTTPIncomingResponse = resources.get(handle) {
                    let fields = HTTPFields()
                    fields.entries = response.headers
                    let fieldsHandle = resources.register(fields)
                    return [.i32(UInt32(bitPattern: fieldsHandle))]
                }
                return [.i32(0)]
            }
        )
        
        // [method]incoming-response.consume: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]incoming-response.consume",
            Function(store: store, parameters: Sig.methodincoming_response_consume.parameters, results: Sig.methodincoming_response_consume.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let response: HTTPIncomingResponse = resources.get(handle),
                   !response.bodyConsumed {
                    response.bodyConsumed = true
                    let incomingBody = HTTPIncomingBody(data: response.body)
                    let bodyHandle = resources.register(incomingBody)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                        buf.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Future Incoming Response
    
    private func registerFutureIncomingResponse(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [method]future-incoming-response.subscribe: (handle) -> i32
        imports.define(module: module, name: "[method]future-incoming-response.subscribe",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let futureHandle = Int32(bitPattern: args[0].i32)
                if let future: FutureIncomingResponse = resources.get(futureHandle) {
                    let pollable = FuturePollable(future: future)
                    let pollableHandle = resources.register(pollable)
                    return [.i32(UInt32(bitPattern: pollableHandle))]
                }
                return [.i32(0)]
            }
        )
        
        // [method]future-incoming-response.get: (handle, ret_ptr) -> ()
        // Returns: Option<Result<Result<incoming-response, error-code>, ()>>
        // Memory layout: 56 bytes (40 + 4 * sizeof(ptr) on 32-bit)
        // - offset 0: u8 option discriminant (0 = None, 1 = Some)
        // - offset 8: u8 outer result discriminant (0 = Ok, 1 = Err ())
        // - offset 16: u8 inner result discriminant (0 = Ok [response], 1 = Err [error-code])
        // - offset 24: i32 response handle (if inner Ok)
        imports.define(module: module, name: "[method]future-incoming-response.get",
            Function(store: store, parameters: Sig.methodfuture_incoming_response_get.parameters, results: Sig.methodfuture_incoming_response_get.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                // Zero-initialize full result area to prevent garbage interpretation
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 56) { buf in
                    for i in 0..<56 { buf[i] = 0 }
                }
                
                if let future: FutureIncomingResponse = resources.get(handle),
                   let response = future.response {
                    let responseHandle = resources.register(response)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 56) { buf in
                        buf[0] = 1   // Some
                        buf[8] = 0   // outer Ok
                        buf[16] = 0  // inner Ok (got response)
                        buf.storeBytes(of: UInt32(bitPattern: responseHandle).littleEndian, toByteOffset: 24, as: UInt32.self)
                    }
                } else {
                    // Not ready yet - return None
                    // Already zero-initialized, offset 0 = 0 means None
                }
                return []
            }
        )
    }
    
    // MARK: - Incoming Body
    
    private func registerIncomingBody(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [method]incoming-body.stream: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]incoming-body.stream",
            Function(store: store, parameters: Sig.methodincoming_body_stream.parameters, results: Sig.methodincoming_body_stream.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let _: HTTPIncomingBody = resources.get(handle) {
                    // Return the body handle itself as the stream handle
                    // The body acts as the stream for read operations
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                        buf.storeBytes(of: UInt32(bitPattern: handle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                }
                return []
            }
        )
        
        // [static]incoming-body.finish: (handle) -> i32
        imports.define(module: module, name: "[static]incoming-body.finish",
            Function(store: store, parameters: Sig.staticincoming_body_finish.parameters, results: Sig.staticincoming_body_finish.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                // Create future-trailers handle
                let futureTrailers = FutureTrailers()
                let futureHandle = resources.register(futureTrailers)
                return [.i32(UInt32(bitPattern: futureHandle))]
            }
        )
    }
    
    // MARK: - HTTP Server Types
    
    private func registerHttpServer(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // [constructor]outgoing-response: (headers_handle) -> i32
        imports.define(module: module, name: "[constructor]outgoing-response",
            Function(store: store, parameters: Sig.constructoroutgoing_response.parameters, results: Sig.constructoroutgoing_response.results) { _, args in
                let headersHandle = Int32(bitPattern: args[0].i32)
                let response = HTTPOutgoingResponseResource(headersHandle: headersHandle)
                let handle = resources.register(response)
                Log.mcp.debug("[constructor]outgoing-response: created handle=\(handle) with headers=\(headersHandle)")
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]outgoing-response.set-status-code: (handle, status) -> i32
        imports.define(module: module, name: "[method]outgoing-response.set-status-code",
            Function(store: store, parameters: Sig.methodoutgoing_response_set_status_code.parameters, results: Sig.methodoutgoing_response_set_status_code.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                let statusCode = args[1].i32
                if let response: HTTPOutgoingResponseResource = resources.get(handle) {
                    response.statusCode = Int(statusCode)
                    return [.i32(0)]
                }
                return [.i32(1)]
            }
        )
        
        // [method]outgoing-response.body: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]outgoing-response.body",
            Function(store: store, parameters: Sig.methodoutgoing_response_body.parameters, results: Sig.methodoutgoing_response_body.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let response: HTTPOutgoingResponseResource = resources.get(handle) {
                    let body = HTTPOutgoingBody()
                    let bodyHandle = resources.register(body)
                    response.bodyHandle = bodyHandle
                    response.outgoingBody = body  // Store direct reference
                    Log.mcp.debug("[method]outgoing-response.body: response=\(handle) -> body=\(bodyHandle)")
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                        buf.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    Log.mcp.warning("[method]outgoing-response.body: invalid response handle=\(handle)")
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                }
                return []
            }
        )
        
        // [static]response-outparam.set - CRITICAL: 9 parameters
        // ABI Layout for result<outgoing-response, error-code>:
        // args[0] = outparam handle
        // args[1] = discriminant (0=ok, 1=err)
        // args[2] = response handle (if ok) or error discriminant (if err)
        // args[3..8] = additional error data if err
        imports.define(module: module, name: "[static]response-outparam.set",
            Function(store: store, parameters: Sig.staticresponse_outparam_set.parameters, results: Sig.staticresponse_outparam_set.results) { _, args in
                // Log all args for debugging
                Log.mcp.debug("[static]response-outparam.set args: \(args.map { "\($0)" }.joined(separator: ", "))")
                
                let outparamHandle = Int32(bitPattern: args[0].i32)
                let isOk = args[1].i32 == 0
                // FIXED: Response handle is at args[2], not args[3]
                let responseHandle = Int32(bitPattern: args[2].i32)
                
                Log.mcp.debug("response-outparam.set: outparam=\(outparamHandle), isOk=\(isOk), response=\(responseHandle)")
                
                if let outparam: ResponseOutparam = resources.get(outparamHandle) {
                    if isOk {
                        if let response: HTTPOutgoingResponseResource = resources.get(responseHandle) {
                            outparam.response = response
                            outparam.responseSet = true
                            Log.mcp.debug("response-outparam.set: SUCCESS - response set with status \(response.statusCode)")
                        } else {
                            Log.mcp.error("response-outparam.set: FAILED - invalid response handle \(responseHandle)")
                        }
                    } else {
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
        
        // [method]incoming-request.headers: (handle) -> i32
        imports.define(module: module, name: "[method]incoming-request.headers",
            Function(store: store, parameters: Sig.methodincoming_request_headers.parameters, results: Sig.methodincoming_request_headers.results) { _, args in
                let requestHandle = Int32(bitPattern: args[0].i32)
                if let request: HTTPIncomingRequest = resources.get(requestHandle) {
                    let handle = resources.register(request.headers)
                    return [.i32(UInt32(bitPattern: handle))]
                }
                let fields = HTTPFields()
                let handle = resources.register(fields)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]incoming-request.path-with-query: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]incoming-request.path-with-query",
            Function(store: store, parameters: Sig.methodincoming_request_path_with_query.parameters, results: Sig.methodincoming_request_path_with_query.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let request: HTTPIncomingRequest = resources.get(requestHandle),
                   let path = request.pathWithQuery {
                    if let reallocFn = caller.instance?.exports[function: "cabi_realloc"] {
                        let pathBytes = Array(path.utf8)
                        if let stringPtr = try? reallocFn([.i32(0), .i32(0), .i32(1), .i32(UInt32(pathBytes.count))]),
                           let ptr = stringPtr.first?.i32 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: pathBytes.count) { buf in
                                for (i, byte) in pathBytes.enumerated() { buf[i] = byte }
                            }
                            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                                buf[0] = 1 // Some
                                buf.storeBytes(of: UInt32(ptr).littleEndian, toByteOffset: 4, as: UInt32.self)
                                buf.storeBytes(of: UInt32(pathBytes.count).littleEndian, toByteOffset: 8, as: UInt32.self)
                            }
                            return []
                        }
                    }
                }
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                    buf[0] = 0 // None
                }
                return []
            }
        )
        
        // [method]incoming-request.consume: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]incoming-request.consume",
            Function(store: store, parameters: Sig.methodincoming_request_consume.parameters, results: Sig.methodincoming_request_consume.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let request: HTTPIncomingRequest = resources.get(requestHandle),
                   !request.bodyConsumed {
                    request.bodyConsumed = true
                    let incomingBody = HTTPIncomingBody(data: request.body)
                    let bodyHandle = resources.register(incomingBody)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                        buf.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1 // Error
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Resource Drops
    
    private func registerResourceDrops(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        let drops: [(String, MCPSignatures.Signature)] = [
            ("[resource-drop]fields", Sig.resource_dropfields),
            ("[resource-drop]outgoing-request", Sig.resource_dropoutgoing_request),
            ("[resource-drop]outgoing-body", Sig.resource_dropoutgoing_body),
            ("[resource-drop]incoming-response", Sig.resource_dropincoming_response),
            ("[resource-drop]future-incoming-response", Sig.resource_dropfuture_incoming_response),
            ("[resource-drop]incoming-body", Sig.resource_dropincoming_body),
            ("[resource-drop]future-trailers", Sig.resource_dropfuture_trailers),
            ("[resource-drop]outgoing-response", Sig.resource_dropoutgoing_response),
            ("[resource-drop]response-outparam", Sig.resource_dropresponse_outparam),
            ("[resource-drop]incoming-request", Sig.resource_dropincoming_request),
            ("[resource-drop]request-options", Sig.resource_droprequest_options),
        ]
        
        for (name, sig) in drops {
            imports.define(module: module, name: name,
                Function(store: store, parameters: sig.parameters, results: sig.results) { _, args in
                    resources.drop(Int32(bitPattern: args[0].i32))
                    return []
                }
            )
        }
    }
    
    // MARK: - Helpers
    
    private static func methodFromDiscriminant(_ disc: UInt32, memory: Memory, ptr: UInt, len: Int) -> String {
        switch disc {
        case 0: return "GET"
        case 1: return "HEAD"
        case 2: return "POST"
        case 3: return "PUT"
        case 4: return "DELETE"
        case 5: return "CONNECT"
        case 6: return "OPTIONS"
        case 7: return "TRACE"
        case 8: return "PATCH"
        default: return memory.readString(offset: ptr, length: len) ?? "GET"
        }
    }
}
