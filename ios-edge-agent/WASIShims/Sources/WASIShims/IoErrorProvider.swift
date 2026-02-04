/// IoErrorProvider.swift
/// Type-safe WASI import provider for wasi:io/error@0.2.9
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import OSLog
import WASIP2Harness

/// Provides type-safe WASI imports for IO error interface.
public struct IoErrorProvider: WASIProvider {
    public static var moduleName: String { "wasi:io/error" }
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:io/error@0.2.9", name: "[resource-drop]error", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/error@0.2.4", name: "[resource-drop]error", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:io/error@0.2.4", name: "[method]error.to-debug-string", parameters: [.i32, .i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    private typealias Sig = MCPSignatures.io_error_0_2_9
    private typealias Sig_0_2_4 = MCPSignatures.io_error_0_2_4
    
    public init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    public func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // wasi:io/error@0.2.9
        let module = "wasi:io/error@0.2.9"
        
        imports.define(module: module, name: "[resource-drop]error",
            Function(store: store, parameters: Sig.resource_droperror.parameters, results: Sig.resource_droperror.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/error@0.2.4
        let module_0_2_4 = "wasi:io/error@0.2.4"
        
        imports.define(module: module_0_2_4, name: "[resource-drop]error",
            Function(store: store, parameters: Sig_0_2_4.resource_droperror.parameters, results: Sig_0_2_4.resource_droperror.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: module_0_2_4, name: "[method]error.to-debug-string",
            Function(store: store, parameters: Sig_0_2_4.methoderror_to_debug_string.parameters, results: Sig_0_2_4.methoderror_to_debug_string.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                // Return empty string for now
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    for i in 0..<8 { buf[i] = 0 }
                }
                return []
            }
        )
    }
}
