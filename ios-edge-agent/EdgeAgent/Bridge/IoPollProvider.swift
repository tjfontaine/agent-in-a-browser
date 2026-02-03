/// IoPollProvider.swift
/// Type-safe WASI import provider for wasi:io/poll@0.2.9
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import OSLog

/// Provides type-safe WASI imports for IO poll interface.
struct IoPollProvider: WASIProvider {
    static var moduleName: String { "wasi:io/poll" }
    
    /// All imports declared by this provider for compile-time validation
    var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:io/poll@0.2.9", name: "[method]pollable.block", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/poll@0.2.9", name: "[method]pollable.ready", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi:io/poll@0.2.9", name: "[resource-drop]pollable", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/poll@0.2.4", name: "[method]pollable.block", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/poll@0.2.4", name: "[resource-drop]pollable", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/poll@0.2.0", name: "[resource-drop]pollable", parameters: [.i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    private typealias Sig = MCPSignatures.io_poll_0_2_9
    private typealias Sig_0_2_0 = MCPSignatures.io_poll_0_2_0
    
    init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        
        let module = "wasi:io/poll@0.2.9"
        
        // [method]pollable.block: (handle) -> ()
        imports.define(module: module, name: "[method]pollable.block",
            Function(store: store, parameters: Sig.methodpollable_block.parameters, results: Sig.methodpollable_block.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                Log.wasiHttp.debug("pollable.block called, handle=\(handle)")
                
                // Check if this is an HTTP future pollable and use semaphore-based waiting
                if let httpPollable: HTTPPollable = resources.get(handle) {
                    Log.wasiHttp.debug("pollable.block: waiting for HTTP response...")
                    // Uses semaphore.wait() - doesn't block main runloop
                    httpPollable.block(timeout: 30)
                    Log.wasiHttp.debug("pollable.block: finished waiting, ready=\(httpPollable.isReady)")
                } else if let streamPollable: StreamPollable = resources.get(handle) {
                    // Stream pollable - wait using its semaphore
                    Log.wasiHttp.debug("pollable.block: waiting for stream data...")
                    streamPollable.block(timeout: 30)
                    Log.wasiHttp.debug("pollable.block: finished waiting for stream, ready=\(streamPollable.isReady)")
                    // Reset pollable for next wait cycle
                    streamPollable.resetForNextWait()
                } else if let processReadyPollable: ProcessReadyPollable = resources.get(handle) {
                    // Process ready pollable - wait for lazy-loaded module
                    Log.wasiHttp.debug("pollable.block: waiting for process to be ready...")
                    processReadyPollable.block()
                    Log.wasiHttp.debug("pollable.block: finished waiting for process, ready=\(processReadyPollable.isReady)")
                } else if let timePollable: TimePollable = resources.get(handle) {
                    // Time pollable - just wait until ready
                    let deadline = Date().addingTimeInterval(30)
                    while !timePollable.isReady && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.01)
                    }
                } else {
                    Log.wasiHttp.debug("pollable.block: NO pollable found for handle \(handle). Returning immediately.")
                }
                
                return []
            }
        )
        
        // [method]pollable.ready: (handle) -> i32
        imports.define(module: module, name: "[method]pollable.ready",
            Function(store: store, parameters: [.i32], results: [.i32]) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                
                if let httpPollable: HTTPPollable = resources.get(handle) {
                    return [.i32(httpPollable.isReady ? 1 : 0)]
                }
                
                if let streamPollable: StreamPollable = resources.get(handle) {
                    return [.i32(streamPollable.isReady ? 1 : 0)]
                }
                
                if let processReadyPollable: ProcessReadyPollable = resources.get(handle) {
                    return [.i32(processReadyPollable.isReady ? 1 : 0)]
                }
                
                if let timePollable: TimePollable = resources.get(handle) {
                    return [.i32(timePollable.isReady ? 1 : 0)]
                }
                
                return [.i32(1)] // Default to ready for unknown pollables
            }
        )
        
        // [resource-drop]pollable
        imports.define(module: module, name: "[resource-drop]pollable",
            Function(store: store, parameters: Sig.resource_droppollable.parameters, results: Sig.resource_droppollable.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // Version 0.2.4 - needed by agent WASM
        let module_0_2_4 = "wasi:io/poll@0.2.4"
        
        imports.define(module: module_0_2_4, name: "[method]pollable.block",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                if let httpPollable: HTTPPollable = resources.get(handle) {
                    httpPollable.block(timeout: 30)
                } else if let streamPollable: StreamPollable = resources.get(handle) {
                    streamPollable.block(timeout: 30)
                    streamPollable.resetForNextWait()
                } else if let processReadyPollable: ProcessReadyPollable = resources.get(handle) {
                    processReadyPollable.block()
                } else if let timePollable: TimePollable = resources.get(handle) {
                    let deadline = Date().addingTimeInterval(30)
                    while !timePollable.isReady && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.01)
                    }
                }
                return []
            }
        )
        
        imports.define(module: module_0_2_4, name: "[resource-drop]pollable",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // Legacy version 0.2.0
        let module_0_2_0 = "wasi:io/poll@0.2.0"
        
        imports.define(module: module_0_2_0, name: "[resource-drop]pollable",
            Function(store: store, parameters: Sig_0_2_0.resource_droppollable.parameters, results: Sig_0_2_0.resource_droppollable.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
}
