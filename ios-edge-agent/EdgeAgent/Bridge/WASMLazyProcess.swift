import Foundation
import WasmKit
import WasmParser
import OSLog

/// Represents a spawned WASM command process
/// Manages stdin/stdout/stderr streams and execution lifecycle
/// Thread-safe: accessed from both MCP WASM thread and background execution task
final class WASMLazyProcess: @unchecked Sendable {
    
    /// Lock for thread-safe access to mutable state
    private let lock = NSLock()
    
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
    private var resources: ResourceRegistry?
    
    // MARK: - Component Model Stream Resources
    
    /// Stream resource types for Component Model shell command interface
    enum StreamResource {
        case stdin
        case stdout
        case stderr
    }
    
    /// Resource handle table for stream handles
    /// tsx-engine's shell:unix/command@0.1.0#run passes stream handles that it will call imports on
    private var streamHandles: [Int32: StreamResource] = [:]
    private var nextStreamHandle: Int32 = 100  // Start at 100 to avoid conflicts with other handles
    
    /// Allocate a stream handle
    private func allocateStreamHandle(_ resource: StreamResource) -> Int32 {
        let handle = nextStreamHandle
        nextStreamHandle += 1
        streamHandles[handle] = resource
        Log.mcp.debug("WASMLazyProcess[\(self.handle)]: Allocated stream handle \(handle) for \(resource)")
        return handle
    }
    
    /// Look up a stream resource by handle
    func lookupStream(_ handle: Int32) -> StreamResource? {
        return streamHandles[handle]
    }
    
    /// Drop a stream handle (resource cleanup)
    private func dropStreamHandle(_ handle: Int32) {
        if streamHandles.removeValue(forKey: handle) != nil {
            Log.mcp.debug("WASMLazyProcess[\(self.handle)]: Dropped stream handle \(handle)")
        }
    }
    
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
        lock.lock()
        defer { lock.unlock() }
        guard !stdinClosed else {
            Log.mcp.warning("WASMLazyProcess[\(handle)]: writeStdin called after close")
            return
        }
        stdinBuffer.append(contentsOf: data)
        Log.mcp.debug("WASMLazyProcess[\(handle)]: writeStdin \(data.count) bytes")
    }
    
    /// Close stdin (signals EOF to the running execution)
    func closeStdin() {
        lock.lock()
        defer { lock.unlock() }
        guard !stdinClosed else { return }
        stdinClosed = true
        Log.mcp.debug("WASMLazyProcess[\(handle)]: closeStdin - \(stdinBuffer.count) bytes buffered")
        // The execute() task is polling for stdinClosed and will proceed
    }
    
    // MARK: - Stdout/Stderr Operations
    
    /// Read available stdout data
    func readStdout() -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        let data = stdoutBuffer
        stdoutBuffer.removeAll()
        return data
    }
    
    /// Read available stderr data
    func readStderr() -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        let data = stderrBuffer
        stderrBuffer.removeAll()
        return data
    }
    
    // MARK: - Process Lifecycle
    
    /// Check if process has completed
    func tryWait() -> Int32? {
        lock.lock()
        defer { lock.unlock() }
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
        lock.lock()
        defer { lock.unlock() }
        return isReadyFlag || !stdoutBuffer.isEmpty || !stderrBuffer.isEmpty
    }
    
    /// Terminate the process
    func terminate() {
        lock.lock()
        executionTask?.cancel()
        state = .completed(exitCode: -1)
        lock.unlock()
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Terminated")
    }
    
    // MARK: - Execution
    
    /// Thread-safe state update
    private func updateState(_ newState: State) {
        lock.lock()
        state = newState
        lock.unlock()
    }
    
    /// Thread-safe buffer append
    private func appendToStderr(_ data: [UInt8]) {
        lock.lock()
        stderrBuffer.append(contentsOf: data)
        lock.unlock()
    }
    
    /// Thread-safe buffer append
    private func appendToStdout(_ data: [UInt8]) {
        lock.lock()
        stdoutBuffer.append(contentsOf: data)
        lock.unlock()
    }
    
    /// Thread-safe ready flag update
    private func markReady() {
        lock.lock()
        isReadyFlag = true
        lock.unlock()
    }
    
    /// Thread-safe check for stdin closed
    private func isStdinClosed() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stdinClosed
    }
    
    /// Thread-safe get stdin buffer (consumes it)
    private func consumeStdinBuffer() -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        let data = stdinBuffer
        stdinBuffer.removeAll()
        return data
    }
    
    private func startExecution() {
        lock.lock()
        guard case .created = state else {
            lock.unlock()
            return
        }
        state = .running
        lock.unlock()
        
        // CRITICAL: Use Task.detached to run on a background thread
        // Regular Task inherits MainActor context, which is blocked by synchronous WASM execution
        // This caused a 30s timeout on first tsx-engine invocation
        executionTask = Task.detached(priority: .userInitiated) { [self] in
            await execute()
        }
    }
    
    private func execute() async {
        Log.mcp.info("WASMLazyProcess[\(handle)]: Loading module for '\(command)' \(args)")
        
        do {
            // Get the module for this command (use thread-safe static method)
            guard let moduleName = LazyModuleRegistry.getModuleForCommandSync(command) else {
                // If not a lazy command, treat it as a shell built-in
                // Built-ins run immediately (they don't need stdin first)
                let result = handleBuiltinCommand()
                updateState(.completed(exitCode: result))
                markReady()
                return
            }
            
            // Load the module (synchronous, thread-safe)
            let module = try LazyModuleRegistry.shared.loadModule(named: moduleName)
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
            self.resources = resources  // Save for Component Model stream registration
            let httpManager = HTTPRequestManager()
            
            // Get MainActor-isolated filesystem reference
            let filesystem = await SandboxFilesystem.shared
            
            // Register WASI imports from type-safe providers
            // Construct providers on MainActor since some are MainActor-isolated
            let providers: [any WASIProvider] = await MainActor.run {
                [
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
                ]
            }
            
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
            markReady()
            Log.mcp.info("WASMLazyProcess[\(handle)]: Ready, waiting for stdin to close")
            
            // Wait for stdin to be closed before executing
            // Poll with a short sleep to avoid busy-waiting
            while !isStdinClosed() {
                try await Task.sleep(nanoseconds: 10_000_000) // 10ms
            }
            
            Log.mcp.info("WASMLazyProcess[\(handle)]: Stdin closed, executing with \(consumeStdinBuffer().count) bytes of input")
            
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
                    // This is a Component Model export
                    // Signature: (name_ptr, name_len, args_ptr, args_len, cwd_ptr, cwd_len, env_ptr, env_len, stdin, stdout, stderr) -> i32
                    let exitCode = try callShellCommandExport(instance: instance, function: entryFunc)
                    updateState(.completed(exitCode: exitCode))
                } else {
                    // Standard run or _start
                    let result = try entryFunc([])
                    if let exitValue = result.first, case let .i32(code) = exitValue {
                        updateState(.completed(exitCode: Int32(bitPattern: code)))
                    } else {
                        updateState(.completed(exitCode: 0))
                    }
                }
            } else {
                Log.mcp.error("WASMLazyProcess[\(handle)]: No entry point found. Available exports: \(listExports(instance))")
                updateState(.failed(ModuleLoadError.loadFailed("No entry point found")))
            }
            
        } catch {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Execution failed: \(error)")
            appendToStderr(Array("Error: \(error.localizedDescription)\n".utf8))
            updateState(.failed(error))
            markReady()  // Mark ready even on failure so Rust doesn't wait forever
        }
    }
    
    /// Handle shell built-in commands
    private func handleBuiltinCommand() -> Int32 {
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Handling builtin '\(command)'")
        
        switch command {
        case "echo":
            let output = args.joined(separator: " ") + "\n"
            appendToStdout(Array(output.utf8))
            return 0
            
        case "pwd":
            let output = cwd + "\n"
            appendToStdout(Array(output.utf8))
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
            appendToStderr(Array(error.utf8))
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
    
    /// Call shell:unix/command@0.1.0#run export with Component Model ABI
    /// Signature: (name_ptr, name_len, args_ptr, args_len, cwd_ptr, cwd_len, env_ptr, env_len, stdin, stdout, stderr) -> i32
    private func callShellCommandExport(instance: Instance, function: Function) throws -> Int32 {
        guard let memory = instance.exports[memory: "memory"],
              let realloc = instance.exports[function: "cabi_realloc"],
              let resources = self.resources else {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Missing memory, cabi_realloc, or resources for shell command")
            return 1
        }
        
        // Helper to allocate and write a string to WASM memory
        func allocString(_ str: String) throws -> (ptr: UInt32, len: UInt32) {
            let bytes = Array(str.utf8)
            let len = UInt32(bytes.count)
            if len == 0 {
                return (0, 0)
            }
            guard let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(len)]),
                  let ptrVal = result.first, case let .i32(ptr) = ptrVal else {
                throw WasmKitHostError.allocationFailed
            }
            memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: bytes.count) { buffer in
                for (i, byte) in bytes.enumerated() {
                    buffer[i] = byte
                }
            }
            return (ptr, len)
        }
        
        // 1. Allocate command name
        let (namePtr, nameLen) = try allocString(command)
        
        // 2. Allocate args list<string>
        var argEntries: [(ptr: UInt32, len: UInt32)] = []
        for arg in args {
            let entry = try allocString(arg)
            argEntries.append(entry)
        }
        
        // Allocate array of (ptr, len) pairs
        let argsArraySize = UInt32(argEntries.count * 8)
        var argsPtr: UInt32 = 0
        if argsArraySize > 0 {
            if let result = try? realloc([.i32(0), .i32(0), .i32(4), .i32(argsArraySize)]),
               let val = result.first, case let .i32(ptr) = val {
                argsPtr = ptr
            }
            for (i, entry) in argEntries.enumerated() {
                let offset = UInt(argsPtr) + UInt(i * 8)
                memory.withUnsafeMutableBufferPointer(offset: offset, count: 8) { buffer in
                    buffer.storeBytes(of: entry.ptr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: entry.len.littleEndian, toByteOffset: 4, as: UInt32.self)
                }
            }
        }
        let argsLen = UInt32(argEntries.count)
        
        // 3. Allocate cwd string
        let (cwdPtr, cwdLen) = try allocString(cwd)
        
        // 4. Allocate env vars list<tuple<string,string>>
        let envPairs = Array(env)
        var envEntries: [(keyPtr: UInt32, keyLen: UInt32, valPtr: UInt32, valLen: UInt32)] = []
        for (key, value) in envPairs {
            let keyEntry = try allocString(key)
            let valEntry = try allocString(value)
            envEntries.append((keyEntry.ptr, keyEntry.len, valEntry.ptr, valEntry.len))
        }
        
        let envArraySize = UInt32(envEntries.count * 16)  // Each entry: key_ptr, key_len, val_ptr, val_len
        var envPtr: UInt32 = 0
        if envArraySize > 0 {
            if let result = try? realloc([.i32(0), .i32(0), .i32(4), .i32(envArraySize)]),
               let val = result.first, case let .i32(ptr) = val {
                envPtr = ptr
            }
            for (i, entry) in envEntries.enumerated() {
                let offset = UInt(envPtr) + UInt(i * 16)
                memory.withUnsafeMutableBufferPointer(offset: offset, count: 16) { buffer in
                    buffer.storeBytes(of: entry.keyPtr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: entry.keyLen.littleEndian, toByteOffset: 4, as: UInt32.self)
                    buffer.storeBytes(of: entry.valPtr.littleEndian, toByteOffset: 8, as: UInt32.self)
                    buffer.storeBytes(of: entry.valLen.littleEndian, toByteOffset: 12, as: UInt32.self)
                }
            }
        }
        let envLen = UInt32(envEntries.count)
        
        // 5. Create and register stream resources
        // stdin: reads from stdinBuffer
        let stdinStream = ProcessInputStream(data: stdinBuffer)
        let stdinHandle = resources.register(stdinStream)
        
        // stdout: writes to stdoutBuffer  
        let stdoutStream = ProcessOutputStream { [weak self] data in
            self?.stdoutBuffer.append(contentsOf: data)
        }
        let stdoutHandle = resources.register(stdoutStream)
        
        // stderr: writes to stderrBuffer
        let stderrStream = ProcessOutputStream { [weak self] data in
            self?.stderrBuffer.append(contentsOf: data)
        }
        let stderrHandle = resources.register(stderrStream)
        
        Log.mcp.debug("WASMLazyProcess[\(handle)]: Calling shell command '\(command)' with \(args.count) args, streams: in=\(stdinHandle) out=\(stdoutHandle) err=\(stderrHandle)")
        
        // 6. Call the export with all 11 parameters
        let result = try function([
            .i32(namePtr),           // name_ptr
            .i32(nameLen),           // name_len
            .i32(argsPtr),           // args_ptr
            .i32(argsLen),           // args_len
            .i32(cwdPtr),            // cwd_ptr
            .i32(cwdLen),            // cwd_len
            .i32(envPtr),            // env_ptr
            .i32(envLen),            // env_len
            .i32(UInt32(bitPattern: stdinHandle)),   // stdin stream handle
            .i32(UInt32(bitPattern: stdoutHandle)),  // stdout stream handle
            .i32(UInt32(bitPattern: stderrHandle))   // stderr stream handle
        ])
        
        // 7. Read exit code from result
        var exitCode: Int32 = 0
        if let retVal = result.first, case let .i32(code) = retVal {
            exitCode = Int32(bitPattern: code)
        }
        
        Log.mcp.info("WASMLazyProcess[\(handle)]: Shell command returned exit code \(exitCode)")
        
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
