// NativeLoaderImpl.swift
// Implementation of LoaderInterface for iOS

import Foundation
import OSLog

/// Native iOS implementation of the module loader interface.
/// This class bridges between WasmKit callbacks and the MainActor-isolated
/// WASMLazyProcess instances. WASM may run on background threads (e.g., via
/// NativeMCPHost's socket handler), so we use DispatchQueue.main.sync to
/// safely access MainActor-isolated types.
final class NativeLoaderImpl: @unchecked Sendable {
    
    // Process management - accessed via DispatchQueue.main.sync
    // These are nonisolated(unsafe) because we synchronize via main.sync
    nonisolated(unsafe) private var processes: [Int32: WASMLazyProcess] = [:]
    nonisolated(unsafe) private var nextHandle: Int32 = 1
    
    // Shared resource registry for pollables (Sendable via @unchecked)
    private let resources: ResourceRegistry
    
    init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    // MARK: - Process Registry (for resource dispatch)
    
    /// Get a process by handle - must be called from main thread
    func getProcess(_ handle: Int32) -> WASMLazyProcess? {
        return processes[handle]
    }
    
    /// Remove a process by handle
    func removeProcess(_ handle: Int32) {
        processes.removeValue(forKey: handle)
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
    
    /// Spawn a command in a lazy-loaded module
    func spawnLazyCommand(module: String, command: String, args: [String], cwd: String, env: [(String, String)]) -> Int32 {
        Log.mcp.info("spawn-lazy-command: module=\(module) command=\(command)")
        
        let handle = nextHandle
        nextHandle += 1
        
        let envDict = Dictionary(env, uniquingKeysWith: { first, _ in first })
        
        // Create WASMLazyProcess directly - it's now thread-safe with internal locking
        // No longer needs DispatchQueue.main.sync since we removed @MainActor
        processes[handle] = WASMLazyProcess(handle: handle, command: command, args: args, env: envDict, cwd: cwd)
        
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
            let handle = nextHandle
            nextHandle += 1
            let envDict = Dictionary(env, uniquingKeysWith: { first, _ in first })
            // WASMLazyProcess.init is MainActor-isolated
            DispatchQueue.main.sync {
                processes[handle] = WASMLazyProcess(handle: handle, command: command, args: args, env: envDict, cwd: cwd)
            }
            return handle
        }
        
        return spawnLazyCommand(module: moduleName!, command: command, args: args, cwd: cwd, env: env)
    }
    
    // MARK: - Resource Methods (called from LoaderProvider)
    
    /// Get a pollable for when the process has output ready
    func getReadyPollable(handle: Int32) -> Int32 {
        let pollableHandle = resources.register(TimePollable(nanoseconds: 0))
        return pollableHandle
    }
    
    /// Check if output is ready without blocking
    func isReady(handle: Int32) -> Bool {
        return DispatchQueue.main.sync {
            guard let process = processes[handle] else {
                return true  // No process means completed
            }
            return process.isReady()
        }
    }
    
    /// Write data to stdin
    func writeStdin(handle: Int32, data: [UInt8]) -> UInt64 {
        DispatchQueue.main.sync {
            guard let process = processes[handle] else {
                return UInt64(0)
            }
            process.writeStdin(data)
            return UInt64(data.count)
        }
    }
    
    /// Close stdin
    func closeStdin(handle: Int32) {
        DispatchQueue.main.sync {
            processes[handle]?.closeStdin()
        }
    }
    
    /// Read from stdout
    func readStdout(handle: Int32, maxBytes: UInt64) -> [UInt8] {
        return DispatchQueue.main.sync {
            guard let process = processes[handle] else {
                return []
            }
            return process.readStdout()
        }
    }
    
    /// Read from stderr
    func readStderr(handle: Int32, maxBytes: UInt64) -> [UInt8] {
        return DispatchQueue.main.sync {
            guard let process = processes[handle] else {
                return []
            }
            return process.readStderr()
        }
    }
    
    /// Try to get exit status without blocking
    func tryWait(handle: Int32) -> Int32? {
        return DispatchQueue.main.sync {
            guard let process = processes[handle] else {
                return nil
            }
            return process.tryWait()
        }
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
    
    /// Send signal to process
    func sendSignal(handle: Int32, signum: UInt8) {
        DispatchQueue.main.sync {
            if let process = processes[handle] {
                if signum == 15 || signum == 9 { // SIGTERM or SIGKILL
                    process.terminate()
                }
                Log.mcp.debug("lazy-process.send-signal(\(signum)) to handle \(handle)")
            }
        }
    }
}
