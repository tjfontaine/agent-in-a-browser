// NativeLoaderImpl.swift
// Implementation of LoaderInterface for iOS

import Foundation
import OSLog
import WASIP2Harness

/// Native iOS implementation of the module loader interface.
/// Thread-safe via NSLock - can be called from any thread.
/// WASMLazyProcess instances handle their own internal thread safety.
public final class NativeLoaderImpl: @unchecked Sendable {
    
    /// Lock for thread-safe access to processes dictionary
    private let lock = NSLock()
    
    // Process management - protected by lock
    private var processes: [Int32: WASMLazyProcess] = [:]
    private var nextHandle: Int32 = 1
    
    // Shared resource registry for pollables (Sendable via @unchecked)
    private let resources: ResourceRegistry
    
    public init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    // MARK: - Process Registry (for resource dispatch)
    
    /// Get a process by handle (thread-safe)
    func getProcess(_ handle: Int32) -> WASMLazyProcess? {
        lock.lock()
        defer { lock.unlock() }
        return processes[handle]
    }
    
    /// Remove a process by handle (thread-safe)
    func removeProcess(_ handle: Int32) {
        lock.lock()
        processes.removeValue(forKey: handle)
        lock.unlock()
        Log.mcp.debug("Dropped lazy-process handle \(handle)")
    }
    
    // MARK: - LoaderInterface Implementation
    
    /// Get the module name for a lazy-loaded command (none if not a lazy command)
    func getLazyModule(command: String) -> String? {
        // Use thread-safe static accessor (this is called from WASM thread)
        let result = LazyModuleRegistry.getModuleForCommandSync(command)
        if let moduleName = result {
            Log.mcp.debug("get-lazy-module: \(command) -> \(moduleName)")
        } else {
            Log.mcp.debug("get-lazy-module: \(command) -> None")
        }
        return result
    }
    
    /// Spawn a command in a lazy-loaded module (thread-safe)
    func spawnLazyCommand(module: String, command: String, args: [String], cwd: String, env: [(String, String)]) -> Int32 {
        Log.mcp.info("spawn-lazy-command: module=\(module) command=\(command)")
        
        let envDict = Dictionary(env, uniquingKeysWith: { first, _ in first })
        
        // Create process with lock protection for dictionary access
        lock.lock()
        let handle = nextHandle
        nextHandle += 1
        let process = WASMLazyProcess(handle: handle, command: command, args: args, env: envDict, cwd: cwd)
        processes[handle] = process
        lock.unlock()
        
        return handle
    }
    
    /// Spawn an interactive command (enters raw mode automatically)
    func spawnInteractive(module: String, command: String, args: [String], cwd: String, env: [(String, String)], cols: UInt32, rows: UInt32) -> Int32 {
        Log.mcp.info("spawn-interactive: module=\(module) command=\(command) (treating as non-interactive on iOS)")
        // On iOS, we treat interactive commands the same as regular ones
        return spawnLazyCommand(module: module, command: command, args: args, cwd: cwd, env: env)
    }
    
    /// Check if a command is an interactive TUI
    func isInteractiveCommand(command: String) -> Bool {
        Log.mcp.debug("is-interactive-command: \(command)")
        return false
    }
    
    /// Check if JSPI is available
    func hasJspi() -> Bool {
        false
    }
    
    /// Spawn a command in an isolated Worker
    func spawnWorkerCommand(command: String, args: [String], cwd: String, env: [(String, String)]) -> Int32 {
        Log.mcp.info("spawn-worker-command: \(command)")
        
        // Check if this is a lazy command (thread-safe access)
        let moduleName = LazyModuleRegistry.getModuleForCommandSync(command)
        
        if moduleName == nil {
            // If not a lazy command, create process anyway for builtins
            let envDict = Dictionary(env, uniquingKeysWith: { first, _ in first })
            lock.lock()
            let handle = nextHandle
            nextHandle += 1
            processes[handle] = WASMLazyProcess(handle: handle, command: command, args: args, env: envDict, cwd: cwd)
            lock.unlock()
            return handle
        }
        
        return spawnLazyCommand(module: moduleName!, command: command, args: args, cwd: cwd, env: env)
    }
    
    // MARK: - Resource Methods (called from LoaderProvider)
    
    /// Get a pollable for when the process is ready (module loaded)
    func getReadyPollable(handle: Int32) -> Int32 {
        guard let process = getProcess(handle) else {
            // No process - return a pollable that's immediately ready
            return resources.register(TimePollable(nanoseconds: 0))
        }
        // Return a pollable that waits for the process to be ready
        let pollable = ProcessReadyPollable(process: process)
        return resources.register(pollable)
    }
    
    /// Check if output is ready without blocking (thread-safe via WASMLazyProcess)
    func isReady(handle: Int32) -> Bool {
        return getProcess(handle)?.isReady() ?? true  // No process means completed
    }
    
    /// Write data to stdin (thread-safe via WASMLazyProcess)
    func writeStdin(handle: Int32, data: [UInt8]) -> UInt64 {
        guard let process = getProcess(handle) else { return 0 }
        process.writeStdin(data)
        return UInt64(data.count)
    }
    
    /// Close stdin (thread-safe via WASMLazyProcess)
    func closeStdin(handle: Int32) {
        getProcess(handle)?.closeStdin()
    }
    
    /// Read from stdout (thread-safe via WASMLazyProcess)
    func readStdout(handle: Int32, maxBytes: UInt64) -> [UInt8] {
        return getProcess(handle)?.readStdout() ?? []
    }
    
    /// Read from stderr (thread-safe via WASMLazyProcess)
    func readStderr(handle: Int32, maxBytes: UInt64) -> [UInt8] {
        return getProcess(handle)?.readStderr() ?? []
    }
    
    /// Try to get exit status without blocking (thread-safe via WASMLazyProcess)
    func tryWait(handle: Int32) -> Int32? {
        return getProcess(handle)?.tryWait()
    }
    
    /// Get terminal size
    func getTerminalSize(handle: Int32) -> (cols: UInt32, rows: UInt32) {
        return (80, 24)
    }
    
    /// Set terminal size
    func setTerminalSize(handle: Int32, cols: UInt32, rows: UInt32) {
        Log.mcp.debug("lazy-process.set-terminal-size called (no-op on iOS)")
    }
    
    /// Set raw mode
    func setRawMode(handle: Int32, enabled: Bool) {
        Log.mcp.debug("lazy-process.set-raw-mode called (no-op on iOS)")
    }
    
    /// Check if raw mode is enabled
    func isRawMode(handle: Int32) -> Bool {
        false
    }
    
    /// Send signal to process (thread-safe via WASMLazyProcess)
    func sendSignal(handle: Int32, signum: UInt8) {
        if let process = getProcess(handle) {
            if signum == 15 || signum == 9 { // SIGTERM or SIGKILL
                process.terminate()
            }
            Log.mcp.debug("lazy-process.send-signal(\(signum)) to handle \(handle)")
        }
    }
}

