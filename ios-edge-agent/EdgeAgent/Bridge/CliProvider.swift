/// CliProvider.swift
/// Type-safe WASI import provider for wasi:cli interfaces
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import OSLog

/// Provides type-safe WASI imports for CLI interfaces.
struct CliProvider: WASIProvider {
    static var moduleName: String { "wasi:cli" }
    
    /// All imports declared by this provider for compile-time validation
    var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:cli/stderr@0.2.4", name: "get-stderr", parameters: [], results: [.i32]),
            WASIImportDeclaration(module: "wasi:cli/terminal-output@0.2.9", name: "[resource-drop]terminal-output", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:cli/terminal-stdout@0.2.9", name: "get-terminal-stdout", parameters: [.i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    private typealias StderrSig = MCPSignatures.cli_stderr_0_2_4
    private typealias TermOutputSig = MCPSignatures.cli_terminal_output_0_2_9
    private typealias TermStdoutSig = MCPSignatures.cli_terminal_stdout_0_2_9
    
    init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // wasi:cli/stderr@0.2.4
        let stderrModule = "wasi:cli/stderr@0.2.4"
        
        // get-stderr: () -> i32
        imports.define(module: stderrModule, name: "get-stderr",
            Function(store: store, parameters: StderrSig.get_stderr.parameters, results: StderrSig.get_stderr.results) { _, _ in
                // Return a stderr stream handle (use an output stream)
                let stream = HTTPOutgoingBody()
                let handle = resources.register(stream)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // wasi:cli/stdout@0.2.4
        let stdoutModule = "wasi:cli/stdout@0.2.4"
        
        // get-stdout: () -> i32
        imports.define(module: stdoutModule, name: "get-stdout",
            Function(store: store, parameters: StderrSig.get_stderr.parameters, results: StderrSig.get_stderr.results) { _, _ in
                // Return a stdout stream handle (use an output stream)
                let stream = HTTPOutgoingBody()
                let handle = resources.register(stream)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // wasi:cli/stdin@0.2.4
        let stdinModule = "wasi:cli/stdin@0.2.4"
        
        // get-stdin: () -> i32
        imports.define(module: stdinModule, name: "get-stdin",
            Function(store: store, parameters: StderrSig.get_stderr.parameters, results: StderrSig.get_stderr.results) { _, _ in
                // Return an empty stdin stream (no interactive input on iOS)
                let stream = HTTPIncomingBody(data: Data())
                let handle = resources.register(stream)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // wasi:cli/terminal-output@0.2.9
        let termOutputModule = "wasi:cli/terminal-output@0.2.9"
        
        imports.define(module: termOutputModule, name: "[resource-drop]terminal-output",
            Function(store: store, parameters: TermOutputSig.resource_dropterminal_output.parameters, results: TermOutputSig.resource_dropterminal_output.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:cli/terminal-stdout@0.2.9
        let termStdoutModule = "wasi:cli/terminal-stdout@0.2.9"
        
        // get-terminal-stdout: (ret_ptr) -> ()
        imports.define(module: termStdoutModule, name: "get-terminal-stdout",
            Function(store: store, parameters: TermStdoutSig.get_terminal_stdout.parameters, results: TermStdoutSig.get_terminal_stdout.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let retPtr = UInt(args[0].i32)
                
                // Return None (no terminal available on iOS)
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf[0] = 0 // None
                }
                return []
            }
        )
    }
}
