import Foundation

// MARK: - WasmKit Host Errors

/// Common errors for WASM host operations
public enum WasmKitHostError: Error, LocalizedError {
    case wasmNotFound
    case notLoaded
    case exportNotFound(String)
    case invalidResult
    case invalidString
    case allocationFailed
    case operationFailed(String)
    
    public var errorDescription: String? {
        switch self {
        case .wasmNotFound: return "WASM module not found in bundle"
        case .notLoaded: return "WASM module not loaded"
        case .exportNotFound(let name): return "Export not found: \(name)"
        case .invalidResult: return "Invalid result from WASM function"
        case .invalidString: return "Invalid string encoding"
        case .allocationFailed: return "Memory allocation failed"
        case .operationFailed(let msg): return "Operation failed: \(msg)"
        }
    }
}
