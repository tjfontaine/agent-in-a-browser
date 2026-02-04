import Foundation

// MARK: - Pollable Types

/// Protocol for lazy-loaded process types
/// Implemented by WASMLazyProcess in WASIShims
public protocol LazyProcessProtocol: AnyObject {
    var handle: Int32 { get }
    func isReady() -> Bool
}

/// Pollable for HTTP futures (used by wasi:io/poll)
public class FuturePollable: NSObject {
    public weak var future: FutureIncomingResponse?
    
    public init(future: FutureIncomingResponse) {
        self.future = future
    }
    
    public var isReady: Bool {
        return future?.response != nil || future?.error != nil
    }
    
    public func block(timeout: TimeInterval = 30) {
        guard let future = future else { return }
        _ = future.waitForReady(timeout: timeout)
    }
}

/// Pollable for time-based waiting (monotonic clock)
public class TimePollable: NSObject {
    public let createdAt = Date()
    public let nanoseconds: UInt64
    
    public init(nanoseconds: UInt64) {
        self.nanoseconds = nanoseconds
    }
    
    public var isReady: Bool {
        let elapsed = Date().timeIntervalSince(createdAt) * 1_000_000_000
        return UInt64(elapsed) >= nanoseconds
    }
}

/// Pollable for HTTP stream data availability
public class StreamPollable: NSObject {
    public weak var response: HTTPIncomingResponse?
    public let streamHandle: Int32
    public let semaphore = DispatchSemaphore(value: 0)
    private var signaled = false
    private let lock = NSLock()
    
    public init(response: HTTPIncomingResponse, streamHandle: Int32) {
        self.response = response
        self.streamHandle = streamHandle
        super.init()
    }
    
    public var isReady: Bool {
        guard let response = response else { return true }
        return response.hasUnreadData || response.streamComplete
    }
    
    public func signalDataAvailable() {
        lock.lock()
        if !signaled {
            signaled = true
            semaphore.signal()
        }
        lock.unlock()
    }
    
    public func block(timeout: TimeInterval) {
        guard let response = response else { return }
        
        if response.hasUnreadData || response.streamComplete {
            return
        }
        
        _ = semaphore.wait(timeout: .now() + timeout)
    }
    
    public func resetForNextWait() {
        lock.lock()
        signaled = false
        lock.unlock()
    }
}

/// Pollable that waits for a LazyProcess to become ready
/// Used by get-ready-pollable import to properly wait for module loading
public class ProcessReadyPollable: NSObject {
    public weak var process: (any LazyProcessProtocol)?
    private let timeout: TimeInterval
    
    public init(process: any LazyProcessProtocol, timeout: TimeInterval = 30.0) {
        self.process = process
        self.timeout = timeout
        super.init()
    }
    
    public var isReady: Bool {
        return process?.isReady() ?? true  // No process means done
    }
    
    /// Block until the process is ready or timeout expires
    public func block() {
        guard let process = process else { return }
        
        let startTime = Date()
        
        // Poll every 10ms until ready or timeout
        while !process.isReady() {
            if Date().timeIntervalSince(startTime) > timeout {
                Log.mcp.warning("ProcessReadyPollable: timeout waiting for process \(process.handle)")
                return
            }
            Thread.sleep(forTimeInterval: 0.01)  // 10ms
        }
    }
}

// MARK: - Type Aliases for Backward Compatibility

/// HTTPPollable is used in NativeAgentHost for polling HTTP futures
public typealias HTTPPollable = FuturePollable

/// DurationPollable is used for monotonic clock polling
public typealias DurationPollable = TimePollable
