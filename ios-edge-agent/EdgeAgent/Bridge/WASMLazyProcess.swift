import Foundation
import WasmKit
import WasmParser
import OSLog

/// Represents a spawned WASM command process
/// Manages stdin/stdout/stderr streams and execution lifecycle
@MainActor
class WASMLazyProcess {
    
    /// Unique handle ID for this process
    let handle: Int32
    
    /// Command and arguments
    let command: String
    let args: [String]
    
    /// Environment variables
    let env: [String: String]
    
    /// Working directory
    let cwd: String
    
    /// Process state
    enum State {
        case created
        case running
        case completed(exitCode: Int32)
        case failed(Error)
    }
    
    private(set) var state: State = .created
    
    /// I/O buffers
    private var stdinBuffer: [UInt8] = []
    private var stdinClosed = false
    private var stdoutBuffer: [UInt8] = []
    private var stderrBuffer: [UInt8] = []
    
    /// Ready pollable signal
    private var isReadyFlag = false
    
    /// Execution task
    private var executionTask: Task<Void, Never>?
    
    /// WasmKit runtime components
    private var store: Store?
    private var instance: Instance?
    
    init(handle: Int32, command: String, args: [String], env: [String: String] = [:], cwd: String = "/") {
        self.handle = handle
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Created for command '\(command)' args=\(args)")
        
        // Start loading the module immediately (don't wait for closeStdin)
        // The Rust shell executor calls get_ready_pollable().block() before writing stdin
        startExecution()
    }
    
    // MARK: - Stdin Operations
    
    /// Write data to stdin
    func writeStdin(_ data: [UInt8]) {
        guard !stdinClosed else {
            Log.mcp.warning("WASMLazyProcess[\(handle)]: writeStdin called after close")
            return
        }
        stdinBuffer.append(contentsOf: data)
        Log.mcp.debug("WASMLazyProcess[\(handle)]: writeStdin \(data.count) bytes")
    }
    
    /// Close stdin (signals EOF to the running execution)
    func closeStdin() {
        guard !stdinClosed else { return }
        stdinClosed = true
        Log.mcp.debug("WASMLazyProcess[\(handle)]: closeStdin - \(stdinBuffer.count) bytes buffered")
        // The execute() task is polling for stdinClosed and will proceed
    }
    
    // MARK: - Stdout/Stderr Operations
    
    /// Read available stdout data
    func readStdout() -> [UInt8] {
        let data = stdoutBuffer
        stdoutBuffer.removeAll()
        return data
    }
    
    /// Read available stderr data
    func readStderr() -> [UInt8] {
        let data = stderrBuffer
        stderrBuffer.removeAll()
        return data
    }
    
    // MARK: - Process Lifecycle
    
    /// Check if process has completed
    func tryWait() -> Int32? {
        switch state {
        case .completed(let code):
            return code
        case .failed:
            return -1
        default:
            return nil
        }
    }
    
    /// Check if ready for reading
    func isReady() -> Bool {
        return isReadyFlag || !stdoutBuffer.isEmpty || !stderrBuffer.isEmpty
    }
    
    /// Terminate the process
    func terminate() {
        executionTask?.cancel()
        state = .completed(exitCode: -1)
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Terminated")
    }
    
    // MARK: - Execution
    
    private func startExecution() {
        guard case .created = state else { return }
        state = .running
        
        executionTask = Task {
            await execute()
        }
    }
    
    private func execute() async {
        Log.mcp.info("WASMLazyProcess[\(handle)]: Loading module for '\(command)' \(args)")
        
        do {
            // Get the module for this command
            guard let moduleName = LazyModuleRegistry.shared.getModuleForCommand(command) else {
                // If not a lazy command, treat it as a shell built-in
                // Built-ins run immediately (they don't need stdin first)
                let result = handleBuiltinCommand()
                state = .completed(exitCode: result)
                isReadyFlag = true
                return
            }
            
            // Load the module
            let module = try await LazyModuleRegistry.shared.loadModule(named: moduleName)
            Log.mcp.info("WASMLazyProcess[\(handle)]: Module loaded, waiting for stdin")
            
            // Create runtime
            let engine = Engine()
            store = Store(engine: engine)
            
            guard let store = store else {
                throw ModuleLoadError.loadFailed("Failed to create store")
            }
            
            // Setup imports
            var imports = Imports()
            let resources = ResourceRegistry()
            let httpManager = HTTPRequestManager()
            
            // Register WASI imports from type-safe providers
            let providers: [any WASIProvider] = [
                Preview1Provider(resources: resources, filesystem: SandboxFilesystem.shared),
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
            
            // Register all providers
            for provider in providers {
                provider.register(into: &imports, store: store)
            }
            
            // Configure stdin to read from buffer (overrides some of the above)
            registerProcessIO(&imports, store: store)
            
            // Validate providers against WASM module requirements BEFORE instantiation
            let validationResult = WASIProviderValidator.validate(module: module, providers: providers)
            if !validationResult.isValid {
                let missingImports = validationResult.missingList.joined(separator: ", ")
                Log.mcp.error("WASMLazyProcess[\(handle)]: FATAL - Missing WASI imports: \(missingImports)")
                throw ModuleLoadError.loadFailed("Missing WASI imports: \(missingImports)")
            }
            
            // Instantiate
            instance = try module.instantiate(store: store, imports: imports)
            
            guard let instance = instance else {
                throw ModuleLoadError.loadFailed("Failed to instantiate module")
            }
            
            // Module is now loaded and ready to receive stdin
            isReadyFlag = true
            Log.mcp.info("WASMLazyProcess[\(handle)]: Ready, waiting for stdin to close")
            
            // Wait for stdin to be closed before executing
            // Poll with a short sleep to avoid busy-waiting
            while !stdinClosed {
                try await Task.sleep(nanoseconds: 10_000_000) // 10ms
            }
            
            Log.mcp.info("WASMLazyProcess[\(handle)]: Stdin closed, executing with \(stdinBuffer.count) bytes of input")
            
            // Try to find and call the run export
            // Check for various entry point styles
            let entryFunctionName: String?
            if instance.exports[function: "run"] != nil {
                entryFunctionName = "run"
            } else if instance.exports[function: "_start"] != nil {
                entryFunctionName = "_start"
            } else if instance.exports[function: "shell:unix/command@0.1.0#run"] != nil {
                entryFunctionName = "shell:unix/command@0.1.0#run"
            } else {
                entryFunctionName = nil
            }
            
            if let funcName = entryFunctionName,
               let entryFunc = instance.exports[function: funcName] {
                Log.mcp.info("WASMLazyProcess[\(handle)]: Calling entry point '\(funcName)'")
                
                // shell:unix/command@0.1.0#run expects (command_ptr, command_len, args_ptr, args_len, ret_ptr)
                // For now, try with no args for simple exports
                if funcName == "shell:unix/command@0.1.0#run" {
                    // This is a Component Model export that needs special handling
                    // The command and args need to be written to memory
                    // For MVP, call with the command string
                    let result = try callShellCommand(instance: instance, function: entryFunc)
                    state = .completed(exitCode: result)
                } else {
                    // Standard run or _start
                    let result = try entryFunc([])
                    if let exitValue = result.first, case let .i32(code) = exitValue {
                        state = .completed(exitCode: Int32(bitPattern: code))
                    } else {
                        state = .completed(exitCode: 0)
                    }
                }
            } else {
                Log.mcp.error("WASMLazyProcess[\(handle)]: No entry point found. Available exports: \(listExports(instance))")
                state = .failed(ModuleLoadError.loadFailed("No entry point found"))
            }
            
        } catch {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Execution failed: \(error)")
            stderrBuffer.append(contentsOf: "Error: \(error.localizedDescription)\n".utf8)
            state = .failed(error)
            isReadyFlag = true  // Mark ready even on failure so Rust doesn't wait forever
        }
    }
    
    /// Handle shell built-in commands
    private func handleBuiltinCommand() -> Int32 {
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Handling builtin '\(command)'")
        
        switch command {
        case "echo":
            let output = args.joined(separator: " ") + "\n"
            stdoutBuffer.append(contentsOf: output.utf8)
            return 0
            
        case "pwd":
            let output = cwd + "\n"
            stdoutBuffer.append(contentsOf: output.utf8)
            return 0
            
        case "true":
            return 0
            
        case "false":
            return 1
            
        case "exit":
            let code = args.first.flatMap { Int32($0) } ?? 0
            return code
            
        default:
            let error = "\(command): command not found\n"
            stderrBuffer.append(contentsOf: error.utf8)
            return 127
        }
    }
    
    /// Register I/O imports for this process
    private func registerProcessIO(_ imports: inout Imports, store: Store) {
        // Override stdin to read from our buffer
        imports.define(module: "wasi_snapshot_preview1", name: "fd_read",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(8)] }
                
                let fd = Int32(bitPattern: args[0].i32)
                
                // Only handle stdin (fd 0)
                guard fd == 0 else {
                    // Delegate to filesystem for other FDs
                    return [.i32(8)]  // EBADF
                }
                
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]
                }
                
                let iovsPtr = UInt(args[1].i32)
                let iovsLen = Int(args[2].i32)
                let nreadPtr = UInt(args[3].i32)
                
                // If stdin is empty and closed, return EOF
                if self.stdinBuffer.isEmpty && self.stdinClosed {
                    memory.withUnsafeMutableBufferPointer(offset: nreadPtr, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                    return [.i32(0)]
                }
                
                // Read from stdin buffer
                var totalRead: UInt32 = 0
                for i in 0..<iovsLen {
                    if self.stdinBuffer.isEmpty { break }
                    
                    let iovOffset = iovsPtr + UInt(i * 8)
                    var ptr: UInt32 = 0
                    var len: UInt32 = 0
                    memory.withUnsafeMutableBufferPointer(offset: iovOffset, count: 8) { buffer in
                        ptr = buffer.load(as: UInt32.self).littleEndian
                        len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                    }
                    
                    let copyLen = min(Int(len), self.stdinBuffer.count)
                    if copyLen > 0 {
                        let bytes = Array(self.stdinBuffer.prefix(copyLen))
                        self.stdinBuffer.removeFirst(copyLen)
                        
                        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: copyLen) { buffer in
                            for (j, byte) in bytes.enumerated() {
                                buffer[j] = byte
                            }
                        }
                        totalRead += UInt32(copyLen)
                    }
                }
                
                memory.withUnsafeMutableBufferPointer(offset: nreadPtr, count: 4) { buffer in
                    buffer.storeBytes(of: totalRead.littleEndian, as: UInt32.self)
                }
                return [.i32(0)]
            }
        )
        
        // Capture stdout/stderr
        imports.define(module: "wasi_snapshot_preview1", name: "fd_write",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(8)] }
                guard let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(8)]
                }
                
                let fd = Int(args[0].i32)
                let iovsPtr = UInt(args[1].i32)
                let iovsLen = Int(args[2].i32)
                let nwrittenPtr = UInt(args[3].i32)
                
                var totalWritten: UInt32 = 0
                
                for i in 0..<iovsLen {
                    let iovOffset = iovsPtr + UInt(i * 8)
                    var ptr: UInt32 = 0
                    var len: UInt32 = 0
                    
                    memory.withUnsafeMutableBufferPointer(offset: iovOffset, count: 8) { buffer in
                        ptr = buffer.load(as: UInt32.self).littleEndian
                        len = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                    }
                    
                    if len > 0 {
                        var bytes = [UInt8](repeating: 0, count: Int(len))
                        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: Int(len)) { buffer in
                            for j in 0..<Int(len) {
                                bytes[j] = buffer[j]
                            }
                        }
                        
                        if fd == 1 {
                            self.stdoutBuffer.append(contentsOf: bytes)
                        } else if fd == 2 {
                            self.stderrBuffer.append(contentsOf: bytes)
                        }
                        totalWritten += len
                    }
                }
                
                memory.withUnsafeMutableBufferPointer(offset: nwrittenPtr, count: 4) { buffer in
                    buffer.storeBytes(of: totalWritten.littleEndian, as: UInt32.self)
                }
                
                return [.i32(0)]
            }
        )
    }
    
    // MARK: - Shell Command Interface
    
    /// Call shell:unix/command@0.1.0#run export with command and args
    private func callShellCommand(instance: Instance, function: Function) throws -> Int32 {
        guard let memory = instance.exports[memory: "memory"],
              let realloc = instance.exports[function: "cabi_realloc"] else {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Missing memory or cabi_realloc for shell command")
            return 1
        }
        
        // Allocate and write command string
        let commandBytes = Array(command.utf8)
        let commandLen = Int32(commandBytes.count)
        guard let commandPtrResult = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(commandLen))]),
              let commandPtrVal = commandPtrResult.first, case let .i32(commandPtr) = commandPtrVal else {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Failed to allocate command memory")
            return 1
        }
        memory.withUnsafeMutableBufferPointer(offset: UInt(commandPtr), count: commandBytes.count) { buffer in
            for (i, byte) in commandBytes.enumerated() {
                buffer[i] = byte
            }
        }
        
        // Build args as list<string> - each string is (ptr, len), then overall (ptr, count)
        // For simplicity, concatenate all args and track offsets
        var argData: [(ptr: UInt32, len: Int32)] = []
        for arg in args {
            let argBytes = Array(arg.utf8)
            let argLen = Int32(argBytes.count)
            if argLen > 0 {
                guard let argPtrResult = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(argLen))]),
                      let argPtrVal = argPtrResult.first, case let .i32(argPtr) = argPtrVal else {
                    continue
                }
                memory.withUnsafeMutableBufferPointer(offset: UInt(argPtr), count: argBytes.count) { buffer in
                    for (i, byte) in argBytes.enumerated() {
                        buffer[i] = byte
                    }
                }
                argData.append((ptr: argPtr, len: argLen))
            }
        }
        
        // Allocate args array (each entry is 8 bytes: ptr + len)
        let argsArraySize = Int32(argData.count * 8)
        let argsCount = Int32(argData.count)
        var argsArrayPtr: UInt32 = 0
        if argsArraySize > 0 {
            if let argsResult = try? realloc([.i32(0), .i32(0), .i32(4), .i32(UInt32(argsArraySize))]),
               let argsVal = argsResult.first, case let .i32(ptr) = argsVal {
                argsArrayPtr = ptr
            }
            // Write arg entries
            for (i, entry) in argData.enumerated() {
                let offset = UInt(argsArrayPtr) + UInt(i * 8)
                memory.withUnsafeMutableBufferPointer(offset: offset, count: 8) { buffer in
                    buffer.storeBytes(of: entry.ptr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(entry.len).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
            }
        }
        
        // Allocate return pointer (for result variant)
        guard let retResult = try? realloc([.i32(0), .i32(0), .i32(4), .i32(16)]),
              let retVal = retResult.first, case let .i32(retPtr) = retVal else {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Failed to allocate return memory")
            return 1
        }
        
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Calling shell command '\(command)' with \(args.count) args")
        
        // Call the function: (command_ptr, command_len, args_ptr, args_len, ret_ptr) -> ()
        let _ = try function([
            .i32(commandPtr),
            .i32(UInt32(commandLen)),
            .i32(argsArrayPtr),
            .i32(UInt32(argsCount)),
            .i32(retPtr)
        ])
        
        // Read result from retPtr
        // result<string, i32> layout: discriminant (1 byte), then payload
        var exitCode: Int32 = 0
        memory.withUnsafeMutableBufferPointer(offset: UInt(retPtr), count: 16) { buffer in
            let discriminant = buffer[0]
            if discriminant == 0 {
                // Ok(string) - output is in stdout buffer
                exitCode = 0
            } else {
                // Err(i32) - read error code at offset 4
                exitCode = Int32(bitPattern: buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian)
            }
        }
        
        return exitCode
    }
    
    /// List available exports for debugging
    private func listExports(_ instance: Instance) -> String {
        // This is for debugging - just return a placeholder
        "see wasm-tools output"
    }
    
    // MARK: - Cleanup
    
    deinit {
        executionTask?.cancel()
    }
}
