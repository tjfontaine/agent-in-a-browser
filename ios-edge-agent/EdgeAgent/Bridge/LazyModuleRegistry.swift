import Foundation
import WasmKit
import WasmParser
import OSLog

/// Registry for lazy-loaded WASM command modules
/// Maps command names to their WASM module bundles
/// Thread-safe: can be accessed from any thread
final class LazyModuleRegistry: @unchecked Sendable {
    
    /// Lock for thread-safe cache access
    private let lock = NSLock()
    
    static let shared = LazyModuleRegistry()
    
    /// Command to module name mapping - static for thread-safe access
    private static let commandModules: [String: String] = [
        "tsx": "tsx-engine",
        "tsc": "tsx-engine",
        "sqlite3": "sqlite-module",
        "ratatui-demo": "ratatui-demo",
        "tui-demo": "ratatui-demo",
        "counter": "ratatui-demo",
        "ansi-demo": "ratatui-demo",
        "vim": "edtui-module",
        "edtui": "edtui-module",
        // CoreUtils commands (handled by WASMLazyProcess builtins or ts-runtime-mcp)
        "echo": "coreutils",
        "cat": "coreutils",
        "ls": "coreutils",
        "mkdir": "coreutils",
        "rm": "coreutils",
        "cp": "coreutils",
        "mv": "coreutils",
        "pwd": "coreutils",
        "head": "coreutils",
        "tail": "coreutils",
        "wc": "coreutils",
        "grep": "coreutils",
    ]
    
    /// Thread-safe accessor for command module lookup (can be called from any thread)
    nonisolated static func getModuleForCommandSync(_ command: String) -> String? {
        return commandModules[command]
    }
    
    /// Loaded WASM module instances (cached)
    private var loadedModules: [String: Module] = [:]
    
    /// WASM file paths in the bundle (relative to Resources/WebRuntime)
    private static let modulePaths: [String: String] = [
        "coreutils": "mcp-server-sync/ts-runtime-mcp.core.wasm",
        "tsx-engine": "tsx-engine-sync/tsx-engine.core.wasm",
        "sqlite-module": "sqlite-module-sync/sqlite-module.core.wasm",
        "ratatui-demo": "ratatui-demo-sync/ratatui-demo.core.wasm",
        "edtui-module": "edtui-module-sync/edtui-module.core.wasm",
    ]
    
    private init() {}
    
    // MARK: - Query Methods
    
    /// Check if a command is available as a lazy-loaded module
    func isLazyCommand(_ command: String) -> Bool {
        return Self.commandModules[command] != nil
    }
    
    /// Get the module name for a given command
    func getModuleForCommand(_ command: String) -> String? {
        return Self.commandModules[command]
    }
    
    /// Get list of all available lazy commands
    func getLazyCommandList() -> [String] {
        return Array(Self.commandModules.keys).sorted()
    }
    
    // MARK: - Module Loading
    
    /// Load a WASM module from the bundle (thread-safe)
    func loadModule(named moduleName: String) throws -> Module {
        // Check cache first with lock
        lock.lock()
        if let cached = loadedModules[moduleName] {
            lock.unlock()
            Log.mcp.debug("LazyModuleRegistry: Using cached module '\(moduleName)'")
            return cached
        }
        lock.unlock()
        
        guard let relativePath = Self.modulePaths[moduleName] else {
            Log.mcp.error("LazyModuleRegistry: Unknown module '\(moduleName)'")
            throw ModuleLoadError.unknownModule(moduleName)
        }
        
        // Look for the module in the bundle
        guard let bundleURL = Bundle.main.url(forResource: "WebRuntime", withExtension: nil) else {
            Log.mcp.error("LazyModuleRegistry: WebRuntime bundle not found")
            throw ModuleLoadError.bundleNotFound
        }
        
        let moduleURL = bundleURL.appendingPathComponent(relativePath)
        
        guard FileManager.default.fileExists(atPath: moduleURL.path) else {
            Log.mcp.error("LazyModuleRegistry: WASM file not found at \(moduleURL.path)")
            throw ModuleLoadError.fileNotFound(moduleURL.path)
        }
        
        Log.mcp.info("LazyModuleRegistry: Loading module '\(moduleName)' from \(moduleURL.path)")
        
        do {
            let wasmBytes = try Data(contentsOf: moduleURL)
            let module = try parseWasm(bytes: Array(wasmBytes))
            
            // Store in cache with lock
            lock.lock()
            loadedModules[moduleName] = module
            lock.unlock()
            
            Log.mcp.info("LazyModuleRegistry: Successfully loaded '\(moduleName)'")
            
            return module
        } catch {
            Log.mcp.error("LazyModuleRegistry: Failed to load module: \(error)")
            throw ModuleLoadError.loadFailed(error.localizedDescription)
        }
    }
    
    /// Unload a cached module to free memory
    func unloadModule(named moduleName: String) {
        lock.lock()
        loadedModules.removeValue(forKey: moduleName)
        lock.unlock()
        Log.mcp.debug("LazyModuleRegistry: Unloaded module '\(moduleName)'")
    }
    
    /// Unload all cached modules
    func unloadAllModules() {
        lock.lock()
        loadedModules.removeAll()
        lock.unlock()
        Log.mcp.debug("LazyModuleRegistry: Unloaded all modules")
    }
}

/// Errors that can occur during module loading
enum ModuleLoadError: Error, LocalizedError {
    case unknownModule(String)
    case bundleNotFound
    case fileNotFound(String)
    case loadFailed(String)
    
    var errorDescription: String? {
        switch self {
        case .unknownModule(let name):
            return "Unknown module: \(name)"
        case .bundleNotFound:
            return "WebRuntime bundle not found"
        case .fileNotFound(let path):
            return "WASM file not found: \(path)"
        case .loadFailed(let reason):
            return "Failed to load module: \(reason)"
        }
    }
}
