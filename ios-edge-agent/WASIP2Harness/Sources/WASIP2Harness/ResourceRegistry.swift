import Foundation

// MARK: - Resource Registry

/// Resource registry for WASI handles - shared across all WASM hosts
public final class ResourceRegistry: @unchecked Sendable {
    private var nextHandle: Int32 = 1
    private var resources: [Int32: AnyObject] = [:]
    private let lock = NSLock()
    
    public init() {}
    
    public func register(_ resource: AnyObject) -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        
        let handle = nextHandle
        nextHandle += 1
        resources[handle] = resource
        return handle
    }
    
    public func get<T: AnyObject>(_ handle: Int32) -> T? {
        lock.lock()
        defer { lock.unlock() }
        return resources[handle] as? T
    }
    
    public func drop(_ handle: Int32) {
        lock.lock()
        defer { lock.unlock() }
        resources.removeValue(forKey: handle)
    }
}
