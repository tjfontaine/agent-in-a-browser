/// IoStreamsProvider.swift
/// Type-safe WASI import provider for wasi:io/streams@0.2.9
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import OSLog

/// Provides type-safe WASI imports for IO streams interface.
struct IoStreamsProvider: WASIProvider {
    static var moduleName: String { "wasi:io/streams" }
    
    /// All imports declared by this provider for compile-time validation
    var declaredImports: [WASIImportDeclaration] {
        [
            // 0.2.9 input streams
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.subscribe", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.read", parameters: [.i32, .i64, .i32], results: []),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.blocking-read", parameters: [.i32, .i64, .i32], results: []),
            // 0.2.9 output streams  
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]output-stream.subscribe", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]output-stream.write", parameters: [.i32, .i32, .i32, .i32], results: []),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[method]output-stream.blocking-write-and-flush", parameters: [.i32, .i32, .i32, .i32], results: []),
            // 0.2.9 resource drops
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[resource-drop]input-stream", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.9", name: "[resource-drop]output-stream", parameters: [.i32], results: []),
            // 0.2.4
            WASIImportDeclaration(module: "wasi:io/streams@0.2.4", name: "[resource-drop]output-stream", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.4", name: "[method]output-stream.blocking-write-and-flush", parameters: [.i32, .i32, .i32, .i32], results: []),
            // 0.2.0
            WASIImportDeclaration(module: "wasi:io/streams@0.2.0", name: "[resource-drop]input-stream", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/streams@0.2.0", name: "[resource-drop]output-stream", parameters: [.i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    // Type aliases for readability
    private typealias Sig = MCPSignatures.io_streams_0_2_9
    private typealias Sig_0_2_0 = MCPSignatures.io_streams_0_2_0
    private typealias Sig_0_2_4 = MCPSignatures.io_streams_0_2_4
    
    init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    func register(into imports: inout Imports, store: Store) {
        registerInputStreams(&imports, store: store)
        registerOutputStreams(&imports, store: store)
        registerResourceDrops(&imports, store: store)
        
        // Also register older versions for compatibility
        registerLegacyVersions(&imports, store: store)
    }
    
    // MARK: - Input Streams (0.2.9)
    
    private func registerInputStreams(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        let module = "wasi:io/streams@0.2.9"
        
        // [method]input-stream.subscribe: (handle) -> i32
        imports.define(module: module, name: "[method]input-stream.subscribe",
            Function(store: store, parameters: Sig.methodinput_stream_subscribe.parameters, results: Sig.methodinput_stream_subscribe.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                
                // If we have a body with response, use it for pollable; otherwise return dummy
                if let body: HTTPIncomingBody = resources.get(handle),
                   let response = body.response {
                    let pollable = StreamPollable(response: response, streamHandle: handle)
                    body.addPollable(pollable)
                    let pollableHandle = resources.register(pollable)
                    return [.i32(UInt32(bitPattern: pollableHandle))]
                }
                // Return a dummy pollable handle for unknown streams
                return [.i32(1)]
            }
        )
        
        // [method]input-stream.read: (handle, max_bytes, ret_ptr) -> ()
        imports.define(module: module, name: "[method]input-stream.read",
            Function(store: store, parameters: Sig.methodinput_stream_read.parameters, results: Sig.methodinput_stream_read.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let maxBytes = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                // Check if this is an incoming body stream
                if let body: HTTPIncomingBody = resources.get(handle),
                   let response = body.response {
                    let data = response.readBody(maxBytes: Int(maxBytes))
                    let isEOF = response.streamComplete && !response.hasUnreadData
                    writeStreamResult(data: Array(data), isEOF: isEOF, to: retPtr, memory: memory, caller: caller)
                } else {
                    // Stream not found - return closed error
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        buf[0] = 1 // Error variant
                        buf[4] = 1 // stream-error::closed
                    }
                }
                return []
            }
        )
        
        // [method]input-stream.blocking-read: (handle, max_bytes, ret_ptr) -> ()
        imports.define(module: module, name: "[method]input-stream.blocking-read",
            Function(store: store, parameters: Sig.methodinput_stream_blocking_read.parameters, results: Sig.methodinput_stream_blocking_read.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let maxBytes = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                if let body: HTTPIncomingBody = resources.get(handle),
                   let response = body.response {
                    let data = response.readBody(maxBytes: Int(maxBytes))
                    let isEOF = response.streamComplete && !response.hasUnreadData
                    Log.wasi.debug("blocking-read: read \(data.count) bytes, isEOF=\(isEOF)")
                    writeStreamResult(data: Array(data), isEOF: isEOF, to: retPtr, memory: memory, caller: caller)
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        buf[0] = 1 // Error variant
                        buf[4] = 1 // stream-error::closed
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Output Streams (0.2.9)
    
    private func registerOutputStreams(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        let module = "wasi:io/streams@0.2.9"
        
        // [method]output-stream.subscribe: (handle) -> i32
        imports.define(module: module, name: "[method]output-stream.subscribe",
            Function(store: store, parameters: Sig.methodoutput_stream_subscribe.parameters, results: Sig.methodoutput_stream_subscribe.results) { _, _ in
                // Return a dummy pollable handle for output streams
                return [.i32(1)]
            }
        )
        
        // [method]output-stream.write: (handle, data_ptr, data_len, ret_ptr) -> ()
        imports.define(module: module, name: "[method]output-stream.write",
            Function(store: store, parameters: Sig.methodoutput_stream_write.parameters, results: Sig.methodoutput_stream_write.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let dataPtr = UInt(args[1].i32)
                let dataLen = Int(args[2].i32)
                let retPtr = UInt(args[3].i32)
                
                // Read the data
                var bytes = [UInt8](repeating: 0, count: dataLen)
                memory.withUnsafeMutableBufferPointer(offset: dataPtr, count: dataLen) { buf in
                    for i in 0..<dataLen { bytes[i] = buf[i] }
                }
                
                Log.wasi.debug("[output-stream.write] handle=\(handle), len=\(dataLen)")
                
                // Check if this is an outgoing body
                if let body: HTTPOutgoingBody = resources.get(handle) {
                    body.data.append(contentsOf: bytes)
                    Log.wasi.debug("[output-stream.write] Appended to HTTPOutgoingBody, total=\(body.data.count)")
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                    }
                } else {
                    // Log output for debugging
                    if let str = String(bytes: bytes, encoding: .utf8) {
                        Log.wasi.debug("[STREAM] \(str)")
                    }
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                    }
                }
                return []
            }
        )
        
        // [method]output-stream.blocking-write-and-flush: (handle, data_ptr, data_len, ret_ptr) -> ()
        imports.define(module: module, name: "[method]output-stream.blocking-write-and-flush",
            Function(store: store, parameters: Sig.methodoutput_stream_blocking_write_and_flush.parameters, results: Sig.methodoutput_stream_blocking_write_and_flush.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let dataPtr = UInt(args[1].i32)
                let dataLen = Int(args[2].i32)
                let retPtr = UInt(args[3].i32)
                
                Log.wasi.debug("[blocking-write-and-flush] handle=\(handle), len=\(dataLen)")
                
                var bytes = [UInt8](repeating: 0, count: dataLen)
                memory.withUnsafeMutableBufferPointer(offset: dataPtr, count: dataLen) { buf in
                    for i in 0..<dataLen { bytes[i] = buf[i] }
                }
                
                if let body: HTTPOutgoingBody = resources.get(handle) {
                    body.data.append(contentsOf: bytes)
                    Log.wasi.debug("[blocking-write-and-flush] Appended \(dataLen) bytes to HTTPOutgoingBody, total=\(body.data.count)")
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                    }
                } else {
                    // Log for debugging
                    Log.wasi.debug("[blocking-write-and-flush] Handle \(handle) not HTTPOutgoingBody")
                    if dataLen > 0, let str = String(bytes: bytes, encoding: .utf8) {
                        Log.wasi.debug("[STREAM] \(str)")
                    }
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 0 // Ok
                    }
                }
                return []
            }
        )
    }
    
    // MARK: - Resource Drops
    
    private func registerResourceDrops(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        let module = "wasi:io/streams@0.2.9"
        
        // [resource-drop]input-stream
        imports.define(module: module, name: "[resource-drop]input-stream",
            Function(store: store, parameters: Sig.resource_dropinput_stream.parameters, results: Sig.resource_dropinput_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // [resource-drop]output-stream
        imports.define(module: module, name: "[resource-drop]output-stream",
            Function(store: store, parameters: Sig.resource_dropoutput_stream.parameters, results: Sig.resource_dropoutput_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
    
    // MARK: - Legacy Versions
    
    private func registerLegacyVersions(_ imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // wasi:io/streams@0.2.0 drops
        let module_0_2_0 = "wasi:io/streams@0.2.0"
        
        imports.define(module: module_0_2_0, name: "[resource-drop]input-stream",
            Function(store: store, parameters: Sig_0_2_0.resource_dropinput_stream.parameters, results: Sig_0_2_0.resource_dropinput_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: module_0_2_0, name: "[resource-drop]output-stream",
            Function(store: store, parameters: Sig_0_2_0.resource_dropoutput_stream.parameters, results: Sig_0_2_0.resource_dropoutput_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/streams@0.2.4
        let module_0_2_4 = "wasi:io/streams@0.2.4"
        
        imports.define(module: module_0_2_4, name: "[resource-drop]output-stream",
            Function(store: store, parameters: Sig_0_2_4.resource_dropoutput_stream.parameters, results: Sig_0_2_4.resource_dropoutput_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: module_0_2_4, name: "[method]output-stream.blocking-write-and-flush",
            Function(store: store, parameters: Sig_0_2_4.methodoutput_stream_blocking_write_and_flush.parameters, results: Sig_0_2_4.methodoutput_stream_blocking_write_and_flush.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let dataPtr = UInt(args[1].i32)
                let dataLen = Int(args[2].i32)
                let retPtr = UInt(args[3].i32)
                
                if dataLen > 0 {
                    var bytes = [UInt8](repeating: 0, count: dataLen)
                    memory.withUnsafeMutableBufferPointer(offset: dataPtr, count: dataLen) { buf in
                        for i in 0..<dataLen { bytes[i] = buf[i] }
                    }
                    if let str = String(bytes: bytes, encoding: .utf8) {
                        Log.wasi.debug("[STREAM] \(str)")
                    }
                }
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buf in
                    buf[0] = 0  // Ok tag
                }
                return []
            }
        )
    }
    
    // MARK: - Helpers
    
    private func writeStreamResult(data: [UInt8], isEOF: Bool, to retPtr: UInt, memory: Memory, caller: Caller) {
        if data.isEmpty && isEOF {
            // Stream closed - return stream-error::closed
            Log.wasi.debug("blocking-read: returning EOF (stream-error::closed)")
            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                buf[0] = 1 // Error variant
                buf[4] = 1 // stream-error::closed (1, not 0)
            }
        } else {
            // Allocate result buffer and write data
            guard let realloc = caller.instance?.exports[function: "cabi_realloc"],
                  let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(data.count))]),
                  case let .i32(dataPtr) = result.first else {
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                    buf[0] = 1 // Error
                    buf[4] = 0 // Closed
                }
                return
            }
            
            Log.wasi.debug("blocking-read: wrote \(data.count) bytes at ptr=\(dataPtr)")
            
            memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: data.count) { buf in
                for (i, byte) in data.enumerated() { buf[i] = byte }
            }
            
            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                buf[0] = 0 // Ok variant
                buf.storeBytes(of: dataPtr.littleEndian, toByteOffset: 4, as: UInt32.self)
                buf.storeBytes(of: UInt32(data.count).littleEndian, toByteOffset: 8, as: UInt32.self)
            }
        }
    }
}
