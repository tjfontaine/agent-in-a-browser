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
    
    /// Close stdin (signals EOF and triggers execution)
    func closeStdin() {
        guard !stdinClosed else { return }
        stdinClosed = true
        Log.mcp.debug("WASMLazyProcess[\(handle)]: closeStdin - triggering execution")
        startExecution()
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
        Log.mcp.info("WASMLazyProcess[\(handle)]: Executing '\(command)' \(args)")
        
        do {
            // Get the module for this command
            guard let moduleName = LazyModuleRegistry.shared.getModuleForCommand(command) else {
                // If not a lazy command, treat it as a shell built-in
                let result = handleBuiltinCommand()
                state = .completed(exitCode: result)
                isReadyFlag = true
                return
            }
            
            // Load the module
            let module = try await LazyModuleRegistry.shared.loadModule(named: moduleName)
            
            // Create runtime
            let engine = Engine()
            store = Store(engine: engine)
            
            guard let store = store else {
                throw ModuleLoadError.loadFailed("Failed to create store")
            }
            
            // Setup imports
            var imports = Imports()
            let resources = ResourceRegistry()
            
            // Register WASI imports
            SharedWASIImports.registerPreview1(&imports, store: store, resources: resources)
            SharedWASIImports.registerRandom(&imports, store: store)
            SharedWASIImports.registerClocks(&imports, store: store)
            
            // Configure stdin to read from buffer
            registerProcessIO(&imports, store: store)
            
            // Instantiate
            instance = try module.instantiate(store: store, imports: imports)
            
            guard let instance = instance else {
                throw ModuleLoadError.loadFailed("Failed to instantiate module")
            }
            
            // Try to find and call the run export
            if let run = instance.exports[function: "run"] {
                // Build args array for WASM
                var allArgs = [command] + args
                
                // Most WASM command modules expect (argc, argv) or (name, args, ...)
                // For now, we'll call run with no args and rely on WASI args_get
                let result = try run([])
                
                if let exitValue = result.first, case let .i32(code) = exitValue {
                    state = .completed(exitCode: Int32(bitPattern: code))
                } else {
                    state = .completed(exitCode: 0)
                }
            } else if let wasiStart = instance.exports[function: "_start"] {
                // WASI _start entry point
                let _ = try wasiStart([])
                state = .completed(exitCode: 0)
            } else {
                Log.mcp.error("WASMLazyProcess[\(handle)]: No run or _start export found")
                state = .failed(ModuleLoadError.loadFailed("No entry point found"))
            }
            
        } catch {
            Log.mcp.error("WASMLazyProcess[\(handle)]: Execution failed: \(error)")
            stderrBuffer.append(contentsOf: "Error: \(error.localizedDescription)\n".utf8)
            state = .failed(error)
        }
        
        isReadyFlag = true
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
    
    // MARK: - Cleanup
    
    deinit {
        executionTask?.cancel()
    }
}
