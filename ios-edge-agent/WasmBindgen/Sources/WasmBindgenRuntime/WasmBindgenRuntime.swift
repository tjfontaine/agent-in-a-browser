// WasmBindgen Runtime Library
// Provides protocols, types, and macros for type-safe WASI implementations

import Foundation

// MARK: - Macro Declarations

/// Marks a struct as a WASI import provider that registers functions with WasmKit.
///
/// The struct must conform to the appropriate WASI protocol (e.g., `StreamsProvider`).
/// The macro generates the `register(into:store:memory:)` method that creates
/// type-safe WasmKit Function wrappers.
///
/// - Parameter module: The WASI module path, e.g., "wasi:io/streams@0.2.0"
///
/// Example:
/// ```swift
/// @WASIImport(module: "wasi:io/streams@0.2.0")
/// struct StreamsProviderImpl: StreamsProvider {
///     func read(stream: Int32, len: UInt64) async throws(WASIError) -> [UInt8] {
///         // Implementation
///     }
/// }
/// ```
@attached(member, names: named(register), named(registerImports))
@attached(extension, conformances: WASIImportProvider)
public macro WASIImport(module: String) = #externalMacro(module: "WasmBindgenMacros", type: "WASIImportMacro")

/// Marks a class as a WASI resource with automatic handle tracking.
///
/// Resources are reference-counted objects that WASM code can hold handles to.
/// The macro generates handle management code.
///
/// Example:
/// ```swift
/// @WASIResource
/// final class InputStreamImpl: InputStreamResource {
///     func read(len: UInt64) async throws(WASIError) -> [UInt8] {
///         // Implementation
///     }
/// }
/// ```
@attached(member, names: named(_wasmHandle), named(wasmHandle))
public macro WASIResource() = #externalMacro(module: "WasmBindgenMacros", type: "WASIResourceMacro")

/// Generates a type-safe WasmKit Function wrapper for a WASI function.
///
/// - Parameters:
///   - name: The WASI function name as it appears in imports
///   - params: The WASI parameter types (e.g., `.i32`, `.i64`)
///   - results: The WASI result types
@attached(peer, names: prefixed(_wasm_))
public macro WASIFunction(name: String, params: [WASIValueType], results: [WASIValueType]) = #externalMacro(module: "WasmBindgenMacros", type: "WASIFunctionMacro")

/// Validates that a provider registers all required WASM imports at compile time.
///
/// The macro collects all `@WASIImportFunc` annotations on methods and validates
/// them against the specified import manifest type (e.g., `AgentWASMImports`).
///
/// - Parameter validates: The type containing `required: Set<String>` of import names
///
/// Example:
/// ```swift
/// @WASIProvider(validates: AgentWASMImports.self)
/// struct IoPollProvider {
///     @WASIImportFunc("wasi:io/poll@0.2.9", "[method]pollable.block")
///     func registerPollableBlock(...) { ... }
/// }
/// ```
@attached(member, names: named(declaredImports), named(_validateImportCoverage))
@attached(extension, conformances: WASIImportProvider)
public macro WASIProvider(validates: Any.Type) = #externalMacro(module: "WasmBindgenMacros", type: "WASIProviderMacro")

/// Marks a function as registering a specific WASI import.
///
/// Used with `@WASIProvider` for compile-time validation of import coverage.
///
/// - Parameters:
///   - module: The WASI module path, e.g., "wasi:io/poll@0.2.9"
///   - name: The function name, e.g., "[method]pollable.block"
@attached(peer)
public macro WASIImportFunc(_ module: String, _ name: String) = #externalMacro(module: "WasmBindgenMacros", type: "WASIImportFuncMacro")

// MARK: - Core Protocols

/// Protocol for types that can register WASI imports with WasmKit.
///
/// Types conforming to this protocol can be used to provide host implementations
/// for WASI functions. The `@WASIImport` macro can generate conformance.
public protocol WASIImportProvider: Sendable {
    /// Register this provider's imports into a WasmKit Imports instance.
    ///
    /// - Parameters:
    ///   - imports: The WasmKit Imports to register into
    ///   - store: The WasmKit Store for function creation
    ///   - memory: A closure that returns the WASM memory (may be nil during early registration)
    func register(into imports: inout Any, store: Any, memory: @escaping () -> Any?)
}

/// Protocol for WASI resource implementations.
///
/// Resources are host objects that WASM code can reference via handles.
/// They support automatic lifecycle management.
public protocol WASIResourceType: AnyObject, Sendable {
    /// The WASM handle assigned to this resource
    var wasmHandle: Int32 { get set }
}

// MARK: - WASI Error Types

/// Comprehensive WASI error types with typed throws support (Swift 6+).
///
/// These errors map to WASI errno values and can be used with typed throws:
/// ```swift
/// func read() async throws(WASIError) -> [UInt8]
/// ```
public enum WASIError: Error, Sendable, Equatable {
    // File system errors
    case accessDenied          // EACCES (2)
    case addressInUse          // EADDRINUSE (3)
    case addressNotAvailable   // EADDRNOTAVAIL (4)
    case alreadyExists         // EEXIST (20)
    case badFileDescriptor     // EBADF (8)
    case busy                  // EBUSY (10)
    case connectionAborted     // ECONNABORTED (13)
    case connectionRefused     // ECONNREFUSED (14)
    case connectionReset       // ECONNRESET (15)
    case deadlock              // EDEADLK (16)
    case directoryNotEmpty     // ENOTEMPTY (55)
    case invalidArgument       // EINVAL (28)
    case invalidSeek           // ESPIPE (70)
    case isDirectory           // EISDIR (31)
    case nameTooLong           // ENAMETOOLONG (37)
    case noDevice              // ENODEV (40)
    case noEntry               // ENOENT (44)
    case noSpace               // ENOSPC (51)
    case notADirectory         // ENOTDIR (54)
    case notSupported          // ENOTSUP (58)
    case permissionDenied      // EPERM (63)
    case readOnlyFilesystem    // EROFS (69)
    case timedOut              // ETIMEDOUT (73)
    case wouldBlock            // EAGAIN (6)
    
    // Stream errors
    case streamClosed
    case streamError
    
    // Resource errors
    case invalidHandle(Int32)
    case resourceBusy
    
    // Generic
    case unknown(errno: Int32)
    
    /// Convert to WASI errno value
    public var errno: Int32 {
        switch self {
        case .accessDenied: return 2
        case .addressInUse: return 3
        case .addressNotAvailable: return 4
        case .alreadyExists: return 20
        case .badFileDescriptor: return 8
        case .busy: return 10
        case .connectionAborted: return 13
        case .connectionRefused: return 14
        case .connectionReset: return 15
        case .deadlock: return 16
        case .directoryNotEmpty: return 55
        case .invalidArgument: return 28
        case .invalidSeek: return 70
        case .isDirectory: return 31
        case .nameTooLong: return 37
        case .noDevice: return 40
        case .noEntry: return 44
        case .noSpace: return 51
        case .notADirectory: return 54
        case .notSupported: return 58
        case .permissionDenied: return 63
        case .readOnlyFilesystem: return 69
        case .timedOut: return 73
        case .wouldBlock: return 6
        case .streamClosed: return 0  // Special handling
        case .streamError: return 29  // EIO
        case .invalidHandle: return 8  // EBADF
        case .resourceBusy: return 10  // EBUSY
        case .unknown(let errno): return errno
        }
    }
    
    /// Create from WASI errno value
    public init(errno: Int32) {
        switch errno {
        case 2: self = .accessDenied
        case 3: self = .addressInUse
        case 4: self = .addressNotAvailable
        case 6: self = .wouldBlock
        case 8: self = .badFileDescriptor
        case 10: self = .busy
        case 13: self = .connectionAborted
        case 14: self = .connectionRefused
        case 15: self = .connectionReset
        case 16: self = .deadlock
        case 20: self = .alreadyExists
        case 28: self = .invalidArgument
        case 31: self = .isDirectory
        case 37: self = .nameTooLong
        case 40: self = .noDevice
        case 44: self = .noEntry
        case 51: self = .noSpace
        case 54: self = .notADirectory
        case 55: self = .directoryNotEmpty
        case 58: self = .notSupported
        case 63: self = .permissionDenied
        case 69: self = .readOnlyFilesystem
        case 70: self = .invalidSeek
        case 73: self = .timedOut
        default: self = .unknown(errno: errno)
        }
    }
}

// MARK: - Value Types

/// WASI value types for function signatures
public enum WASIValueType: Sendable {
    case i32
    case i64
    case f32
    case f64
}

// MARK: - Resource Registry

/// Thread-safe registry for WASI resources.
///
/// Maps Int32 handles to resource instances for host-side lookup.
public actor ResourceRegistry {
    private var resources: [Int32: any WASIResourceType] = [:]
    private var nextHandle: Int32 = 1
    
    public init() {}
    
    /// Register a resource and return its handle
    public func register<T: WASIResourceType>(_ resource: T) -> Int32 {
        let handle = nextHandle
        nextHandle += 1
        resources[handle] = resource
        resource.wasmHandle = handle
        return handle
    }
    
    /// Look up a resource by handle
    public func get<T: WASIResourceType>(_ handle: Int32, as type: T.Type) -> T? {
        resources[handle] as? T
    }
    
    /// Remove a resource by handle
    @discardableResult
    public func remove(_ handle: Int32) -> (any WASIResourceType)? {
        resources.removeValue(forKey: handle)
    }
    
    /// Check if a handle is valid
    public func contains(_ handle: Int32) -> Bool {
        resources[handle] != nil
    }
    
    /// Get the count of registered resources
    public var count: Int {
        resources.count
    }
}

// MARK: - Memory Utilities

/// Utility functions for reading/writing WASM linear memory.
///
/// These provide type-safe memory access with proper endianness handling.
public enum WASIMemory {
    
    /// Read a null-terminated string from WASM memory
    public static func readString(from memory: Any, offset: UInt32, maxLength: Int = 4096) -> String? {
        // Implementation depends on WasmKit Memory type
        // Placeholder - actual implementation uses WasmKit
        fatalError("Use WasmKit Memory directly")
    }
    
    /// Read bytes from WASM memory
    public static func readBytes(from memory: Any, offset: UInt32, length: Int) -> [UInt8] {
        fatalError("Use WasmKit Memory directly")
    }
    
    /// Write bytes to WASM memory
    public static func writeBytes(to memory: Any, offset: UInt32, bytes: [UInt8]) {
        fatalError("Use WasmKit Memory directly")
    }
    
    /// Read a little-endian integer from WASM memory
    public static func readInt32(from memory: Any, offset: UInt32) -> Int32 {
        fatalError("Use WasmKit Memory directly")
    }
    
    /// Write a little-endian integer to WASM memory
    public static func writeInt32(to memory: Any, offset: UInt32, value: Int32) {
        fatalError("Use WasmKit Memory directly")
    }
}

// MARK: - Async Bridge

/// Bridges async Swift code with WasmKit's synchronous function model.
///
/// When using JSPI or native async support, this handles the suspension.
public struct WASIAsyncBridge {
    
    /// Execute an async WASI function in a blocking context.
    ///
    /// This is used when WASM calls an async host function and needs to wait.
    /// On native platforms, this uses semaphores. With JSPI, this suspends.
    public static func runBlocking<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
        // Use Task group for structured concurrency
        let semaphore = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: Result<T, Error>?
        
        Task {
            do {
                let value = try await operation()
                result = .success(value)
            } catch {
                result = .failure(error)
            }
            semaphore.signal()
        }
        
        semaphore.wait()
        
        guard let result else {
            fatalError("Async operation did not complete")
        }
        
        return try result.get()
    }
}
