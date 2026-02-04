/// ModuleLoaderProvider.swift
/// Type-safe WASI import provider for mcp:module-loader/loader@0.1.0
///
/// Uses MCPSignatures constants for ABI-correct function signatures.
/// This ensures compile-time type safety matching the actual WASM binary.

import WasmKit
import WASIP2Harness
import OSLog

/// Provides type-safe WASI imports for the module-loader interface.
/// Uses signature constants from MCPSignatures.swift (generated from WASM binary).
public struct ModuleLoaderProvider: WASIProvider {
    
    public static var moduleName: String { "mcp:module-loader/loader@0.1.0" }
    
    private let loader: NativeLoaderImpl
    private let module = "mcp:module-loader/loader@0.1.0"
    
    // Type alias for readability
    private typealias Sig = MCPSignatures.module_loader_loader_0_1_0
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        let m = Self.moduleName
        return [
            WASIImportDeclaration(module: m, name: "get-lazy-module", parameters: Sig.get_lazy_module.parameters, results: Sig.get_lazy_module.results),
            WASIImportDeclaration(module: m, name: "is-interactive-command", parameters: Sig.is_interactive_command.parameters, results: Sig.is_interactive_command.results),
            WASIImportDeclaration(module: m, name: "has-jspi", parameters: Sig.has_jspi.parameters, results: Sig.has_jspi.results),
            WASIImportDeclaration(module: m, name: "spawn-lazy-command", parameters: Sig.spawn_lazy_command.parameters, results: Sig.spawn_lazy_command.results),
            WASIImportDeclaration(module: m, name: "spawn-interactive", parameters: Sig.spawn_interactive.parameters, results: Sig.spawn_interactive.results),
            WASIImportDeclaration(module: m, name: "spawn-worker-command", parameters: Sig.spawn_worker_command.parameters, results: Sig.spawn_worker_command.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.set-raw-mode", parameters: Sig.methodlazy_process_set_raw_mode.parameters, results: Sig.methodlazy_process_set_raw_mode.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.write-stdin", parameters: Sig.methodlazy_process_write_stdin.parameters, results: Sig.methodlazy_process_write_stdin.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.close-stdin", parameters: Sig.methodlazy_process_close_stdin.parameters, results: Sig.methodlazy_process_close_stdin.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.read-stdout", parameters: Sig.methodlazy_process_read_stdout.parameters, results: Sig.methodlazy_process_read_stdout.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.read-stderr", parameters: Sig.methodlazy_process_read_stderr.parameters, results: Sig.methodlazy_process_read_stderr.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.get-ready-pollable", parameters: Sig.methodlazy_process_get_ready_pollable.parameters, results: Sig.methodlazy_process_get_ready_pollable.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.is-ready", parameters: Sig.methodlazy_process_is_ready.parameters, results: Sig.methodlazy_process_is_ready.results),
            WASIImportDeclaration(module: m, name: "[method]lazy-process.try-wait", parameters: Sig.methodlazy_process_try_wait.parameters, results: Sig.methodlazy_process_try_wait.results),
            WASIImportDeclaration(module: m, name: "[resource-drop]lazy-process", parameters: Sig.resource_droplazy_process.parameters, results: Sig.resource_droplazy_process.results),
        ]
    }
    
    public init(loader: NativeLoaderImpl) {
        self.loader = loader
    }
    
    /// Register all module-loader imports into the given Imports collection.
    /// Each function uses MCPSignatures for correct parameter/result types.
    public func register(into imports: inout Imports, store: Store) {
        registerFunctions(&imports, store: store)
        registerResourceMethods(&imports, store: store)
    }
    
    // MARK: - Top-Level Functions
    
    private func registerFunctions(_ imports: inout Imports, store: Store) {
        let loader = self.loader
        
        // get-lazy-module: (ptr, len, ret_ptr) -> ()
        imports.define(module: module, name: "get-lazy-module",
            Function(store: store, parameters: Sig.get_lazy_module.parameters, results: Sig.get_lazy_module.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let ptr = UInt(args[0].i32)
                let len = Int(args[1].i32)
                let retPtr = UInt(args[2].i32)
                
                let command = memory.readString(offset: ptr, length: len) ?? ""
                let moduleName = loader.getLazyModule(command: command)
                
                // Write option<string> result: 0=none, 1=some with (ptr, len)
                if let name = moduleName {
                    guard let realloc = caller.instance?.exports[function: "cabi_realloc"],
                          let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(name.utf8.count))]),
                          case let .i32(strPtr) = result.first else {
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                            for i in 0..<12 { buf[i] = 0 }
                        }
                        return []
                    }
                    let bytes = Array(name.utf8)
                    memory.withUnsafeMutableBufferPointer(offset: UInt(strPtr), count: bytes.count) { buf in
                        for (i, b) in bytes.enumerated() { buf[i] = b }
                    }
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        buf[0] = 1 // some
                        buf.storeBytes(of: strPtr.littleEndian, toByteOffset: 4, as: UInt32.self)
                        buf.storeBytes(of: UInt32(bytes.count).littleEndian, toByteOffset: 8, as: UInt32.self)
                    }
                } else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buf in
                        for i in 0..<12 { buf[i] = 0 }
                    }
                }
                return []
            }
        )
        
        // is-interactive-command: (ptr, len) -> i32
        imports.define(module: module, name: "is-interactive-command",
            Function(store: store, parameters: Sig.is_interactive_command.parameters, results: Sig.is_interactive_command.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                
                let ptr = UInt(args[0].i32)
                let len = Int(args[1].i32)
                let command = memory.readString(offset: ptr, length: len) ?? ""
                
                return [.i32(loader.isInteractiveCommand(command: command) ? 1 : 0)]
            }
        )
        
        // has-jspi: () -> i32
        imports.define(module: module, name: "has-jspi",
            Function(store: store, parameters: Sig.has_jspi.parameters, results: Sig.has_jspi.results) { _, _ in
                return [.i32(loader.hasJspi() ? 1 : 0)]
            }
        )
        
        // spawn-lazy-command: (module_ptr, module_len, cmd_ptr, cmd_len, args_ptr, args_len, cwd_ptr, cwd_len, env_ptr, env_len) -> i32
        imports.define(module: module, name: "spawn-lazy-command",
            Function(store: store, parameters: Sig.spawn_lazy_command.parameters, results: Sig.spawn_lazy_command.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                
                let modulePtr = UInt(args[0].i32), moduleLen = Int(args[1].i32)
                let cmdPtr = UInt(args[2].i32), cmdLen = Int(args[3].i32)
                let argsPtr = UInt(args[4].i32), argsCount = Int(args[5].i32)
                let cwdPtr = UInt(args[6].i32), cwdLen = Int(args[7].i32)
                let envPtr = UInt(args[8].i32), envCount = Int(args[9].i32)
                
                let moduleName = memory.readString(offset: modulePtr, length: moduleLen) ?? ""
                let command = memory.readString(offset: cmdPtr, length: cmdLen) ?? ""
                let argsList = memory.readStringList(offset: argsPtr, count: argsCount)
                let cwd = memory.readString(offset: cwdPtr, length: cwdLen) ?? "/"
                let envTuples = memory.readEnvList(offset: envPtr, count: envCount)
                
                let handle = loader.spawnLazyCommand(
                    module: moduleName, command: command, args: argsList,
                    cwd: cwd, env: envTuples
                )
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // spawn-interactive: (module, cmd, args, cwd, env, cols, rows, ...) -> i32
        imports.define(module: module, name: "spawn-interactive",
            Function(store: store, parameters: Sig.spawn_interactive.parameters, results: Sig.spawn_interactive.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                
                let modulePtr = UInt(args[0].i32), moduleLen = Int(args[1].i32)
                let cmdPtr = UInt(args[2].i32), cmdLen = Int(args[3].i32)
                let argsPtr = UInt(args[4].i32), argsCount = Int(args[5].i32)
                let cwdPtr = UInt(args[6].i32), cwdLen = Int(args[7].i32)
                let envPtr = UInt(args[8].i32), envCount = Int(args[9].i32)
                let cols = args[10].i32
                let rows = args[11].i32
                
                let moduleName = memory.readString(offset: modulePtr, length: moduleLen) ?? ""
                let command = memory.readString(offset: cmdPtr, length: cmdLen) ?? ""
                let argsList = memory.readStringList(offset: argsPtr, count: argsCount)
                let cwd = memory.readString(offset: cwdPtr, length: cwdLen) ?? "/"
                let envTuples = memory.readEnvList(offset: envPtr, count: envCount)
                
                let handle = loader.spawnInteractive(
                    module: moduleName, command: command, args: argsList,
                    cwd: cwd, env: envTuples, cols: cols, rows: rows
                )
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // spawn-worker-command: (cmd_ptr, cmd_len, args_ptr, args_len, cwd_ptr, cwd_len, env_ptr, env_len) -> i32
        imports.define(module: module, name: "spawn-worker-command",
            Function(store: store, parameters: Sig.spawn_worker_command.parameters, results: Sig.spawn_worker_command.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i32(0)] }
                
                let cmdPtr = UInt(args[0].i32), cmdLen = Int(args[1].i32)
                let argsPtr = UInt(args[2].i32), argsCount = Int(args[3].i32)
                let cwdPtr = UInt(args[4].i32), cwdLen = Int(args[5].i32)
                let envPtr = UInt(args[6].i32), envCount = Int(args[7].i32)
                
                let command = memory.readString(offset: cmdPtr, length: cmdLen) ?? ""
                let argsList = memory.readStringList(offset: argsPtr, count: argsCount)
                let cwd = memory.readString(offset: cwdPtr, length: cwdLen) ?? "/"
                let envTuples = memory.readEnvList(offset: envPtr, count: envCount)
                
                let handle = loader.spawnWorkerCommand(
                    command: command, args: argsList, cwd: cwd, env: envTuples
                )
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
    }
    
    // MARK: - Resource Methods
    
    private func registerResourceMethods(_ imports: inout Imports, store: Store) {
        let loader = self.loader
        
        // [method]lazy-process.set-raw-mode: (handle, enabled) -> ()
        imports.define(module: module, name: "[method]lazy-process.set-raw-mode",
            Function(store: store, parameters: Sig.methodlazy_process_set_raw_mode.parameters, results: Sig.methodlazy_process_set_raw_mode.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                let enabled = args[1].i32 != 0
                loader.setRawMode(handle: handle, enabled: enabled)
                return []
            }
        )
        
        // [method]lazy-process.write-stdin: (handle, ptr, len) -> i64
        imports.define(module: module, name: "[method]lazy-process.write-stdin",
            Function(store: store, parameters: Sig.methodlazy_process_write_stdin.parameters, results: Sig.methodlazy_process_write_stdin.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [.i64(0)] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let ptr = UInt(args[1].i32)
                let len = Int(args[2].i32)
                
                var bytes = [UInt8](repeating: 0, count: len)
                memory.withUnsafeMutableBufferPointer(offset: ptr, count: len) { buf in
                    for i in 0..<len { bytes[i] = buf[i] }
                }
                
                let written = loader.writeStdin(handle: handle, data: bytes)
                return [.i64(written)]
            }
        )
        
        // [method]lazy-process.close-stdin: (handle) -> ()
        imports.define(module: module, name: "[method]lazy-process.close-stdin",
            Function(store: store, parameters: Sig.methodlazy_process_close_stdin.parameters, results: Sig.methodlazy_process_close_stdin.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                loader.closeStdin(handle: handle)
                return []
            }
        )
        
        // [method]lazy-process.read-stdout: (handle, maxBytes, ret_ptr) -> ()
        imports.define(module: module, name: "[method]lazy-process.read-stdout",
            Function(store: store, parameters: Sig.methodlazy_process_read_stdout.parameters, results: Sig.methodlazy_process_read_stdout.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let maxBytes = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                let data = loader.readStdout(handle: handle, maxBytes: maxBytes)
                writeListResult(data: data, to: retPtr, memory: memory, caller: caller)
                return []
            }
        )
        
        // [method]lazy-process.read-stderr: (handle, maxBytes, ret_ptr) -> ()
        imports.define(module: module, name: "[method]lazy-process.read-stderr",
            Function(store: store, parameters: Sig.methodlazy_process_read_stderr.parameters, results: Sig.methodlazy_process_read_stderr.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let maxBytes = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                let data = loader.readStderr(handle: handle, maxBytes: maxBytes)
                writeListResult(data: data, to: retPtr, memory: memory, caller: caller)
                return []
            }
        )
        
        // [method]lazy-process.get-ready-pollable: (handle) -> i32
        imports.define(module: module, name: "[method]lazy-process.get-ready-pollable",
            Function(store: store, parameters: Sig.methodlazy_process_get_ready_pollable.parameters, results: Sig.methodlazy_process_get_ready_pollable.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                let pollable = loader.getReadyPollable(handle: handle)
                return [.i32(UInt32(bitPattern: pollable))]
            }
        )
        
        // [method]lazy-process.is-ready: (handle) -> i32
        imports.define(module: module, name: "[method]lazy-process.is-ready",
            Function(store: store, parameters: Sig.methodlazy_process_is_ready.parameters, results: Sig.methodlazy_process_is_ready.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                return [.i32(loader.isReady(handle: handle) ? 1 : 0)]
            }
        )
        
        // [method]lazy-process.try-wait: (handle, ret_ptr) -> ()
        imports.define(module: module, name: "[method]lazy-process.try-wait",
            Function(store: store, parameters: Sig.methodlazy_process_try_wait.parameters, results: Sig.methodlazy_process_try_wait.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let handle = Int32(bitPattern: args[0].i32)
                let retPtr = UInt(args[1].i32)
                
                if let exitCode = loader.tryWait(handle: handle) {
                    // Some: discriminant=1, then i32 exit code
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        buf[0] = 1
                        buf.storeBytes(of: exitCode.littleEndian, toByteOffset: 4, as: Int32.self)
                    }
                } else {
                    // None: discriminant=0
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        for i in 0..<8 { buf[i] = 0 }
                    }
                }
                return []
            }
        )
        
        // [resource-drop]lazy-process: (handle) -> ()
        imports.define(module: module, name: "[resource-drop]lazy-process",
            Function(store: store, parameters: Sig.resource_droplazy_process.parameters, results: Sig.resource_droplazy_process.results) { _, args in
                let handle = Int32(bitPattern: args[0].i32)
                loader.removeProcess(handle)
                return []
            }
        )
    }
    
    // MARK: - Helpers
    
    /// Write a list<u8> result to memory at ret_ptr.
    /// Format: (ptr: u32, len: u32)
    private func writeListResult(data: [UInt8], to retPtr: UInt, memory: Memory, caller: Caller) {
        if data.isEmpty {
            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                for i in 0..<8 { buf[i] = 0 }
            }
        } else {
            guard let realloc = caller.instance?.exports[function: "cabi_realloc"],
                  let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(data.count))]),
                  case let .i32(dataPtr) = result.first else {
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    for i in 0..<8 { buf[i] = 0 }
                }
                return
            }
            memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: data.count) { buf in
                for (i, byte) in data.enumerated() { buf[i] = byte }
            }
            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                buf.storeBytes(of: dataPtr.littleEndian, as: UInt32.self)
                buf.storeBytes(of: UInt32(data.count).littleEndian, toByteOffset: 4, as: UInt32.self)
            }
        }
    }
}

// MARK: - Memory Extensions

extension Memory {
    /// Read a string from memory
    func readString(offset: UInt, length: Int) -> String? {
        guard length > 0 else { return "" }
        var bytes = [UInt8](repeating: 0, count: length)
        withUnsafeMutableBufferPointer(offset: offset, count: length) { buffer in
            for i in 0..<length { bytes[i] = buffer[i] }
        }
        return String(bytes: bytes, encoding: .utf8)
    }
    
    /// Read a list of strings from memory.
    /// Format: array of (ptr: u32, len: u32) pairs
    func readStringList(offset: UInt, count: Int) -> [String] {
        guard count > 0 else { return [] }
        
        var result: [String] = []
        for i in 0..<count {
            let entryOffset = offset + UInt(i * 8)
            var ptr: UInt32 = 0
            var len: UInt32 = 0
            
            withUnsafeMutableBufferPointer(offset: entryOffset, count: 8) { buffer in
                ptr = buffer.load(fromByteOffset: 0, as: UInt32.self).littleEndian
                len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            
            if let str = readString(offset: UInt(ptr), length: Int(len)) {
                result.append(str)
            }
        }
        return result
    }
    
    /// Read a list of (key, value) environment variable tuples from memory.
    /// Format: array of (key_ptr: u32, key_len: u32, val_ptr: u32, val_len: u32) tuples
    func readEnvList(offset: UInt, count: Int) -> [(String, String)] {
        guard count > 0 else { return [] }
        
        var result: [(String, String)] = []
        for i in 0..<count {
            let entryOffset = offset + UInt(i * 16) // 4 u32s = 16 bytes per entry
            var keyPtr: UInt32 = 0, keyLen: UInt32 = 0
            var valPtr: UInt32 = 0, valLen: UInt32 = 0
            
            withUnsafeMutableBufferPointer(offset: entryOffset, count: 16) { buffer in
                keyPtr = buffer.load(fromByteOffset: 0, as: UInt32.self).littleEndian
                keyLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                valPtr = buffer.load(fromByteOffset: 8, as: UInt32.self).littleEndian
                valLen = buffer.load(fromByteOffset: 12, as: UInt32.self).littleEndian
            }
            
            let key = readString(offset: UInt(keyPtr), length: Int(keyLen)) ?? ""
            let value = readString(offset: UInt(valPtr), length: Int(valLen)) ?? ""
            result.append((key, value))
        }
        return result
    }
}
