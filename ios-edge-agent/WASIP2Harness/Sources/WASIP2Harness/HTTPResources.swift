import Foundation

// MARK: - HTTP Types

/// HTTP header fields container
public class HTTPFields: NSObject {
    public var entries: [(String, String)] = []
    
    public func append(name: String, value: String) {
        entries.append((name, value))
    }
    
    public func set(name: String, value: String) {
        // Remove existing entries with same name and add new one
        entries.removeAll { $0.0.lowercased() == name.lowercased() }
        entries.append((name, value))
    }
}

/// HTTP request options (timeouts)
public class HTTPRequestOptions: NSObject {
    public var connectTimeout: UInt64?
    public var firstByteTimeout: UInt64?
    public var betweenBytesTimeout: UInt64?
}

// MARK: - Server-Side Types (Incoming Requests)

/// Incoming HTTP request (server-side)
public class HTTPIncomingRequest: NSObject {
    public var method: String
    public var pathWithQuery: String?
    public var headers: HTTPFields
    public var body: Data
    public var bodyConsumed = false
    
    public init(method: String = "GET", path: String? = nil, headers: HTTPFields = HTTPFields(), body: Data = Data()) {
        self.method = method
        self.pathWithQuery = path
        self.headers = headers
        self.body = body
        super.init()
    }
}

/// Response out-param for sending responses back (server-side)
public class ResponseOutparam: NSObject {
    public var responseSet = false
    public var response: HTTPOutgoingResponseResource?
    public var error: String?
}

/// Future trailers resource (HTTP/2 trailer headers)
public class FutureTrailers: NSObject {
    public var trailers: HTTPFields?
    public var complete = false
}

// MARK: - Client-Side Types (Outgoing Requests)

/// Outgoing HTTP request (client-side)
public class HTTPOutgoingRequest: NSObject {
    public var headersHandle: Int32
    public var method: String = "GET"
    public var scheme: String = "https"
    public var authority: String = ""
    public var path: String = "/"
    public var outgoingBodyHandle: Int32?
    /// Direct reference to the body (survives registry drops)
    public var outgoingBody: HTTPOutgoingBody?
    
    public init(headers: UInt32) {
        self.headersHandle = Int32(bitPattern: headers)
        super.init()
    }
}

/// Outgoing HTTP body (for requests)
public class HTTPOutgoingBody: NSObject {
    public var data = Data()
    public var outputStreamHandle: Int32?
    public var finished = false
    
    public func write(_ chunk: Data) {
        data.append(chunk)
    }
    
    public func getData() -> Data {
        return data
    }
}

/// Resource for outgoing HTTP responses (server-side)
public class HTTPOutgoingResponseResource: NSObject {
    public var headersHandle: Int32
    public var statusCode: Int = 200
    public var bodyHandle: Int32?
    public var outgoingBody: HTTPOutgoingBody?  // Direct reference to survive registry drops
    
    public init(headersHandle: Int32) {
        self.headersHandle = headersHandle
    }
}

// MARK: - Response Types (Incoming Responses)

/// Incoming HTTP response (client-side)
public class HTTPIncomingResponse: NSObject {
    public let status: Int
    public let headers: [(String, String)]
    public var body: Data
    public var bodyConsumed = false
    public var bodyReadOffset = 0
    public var streamComplete = false
    private let bodyLock = NSLock()
    
    public var onDataAvailable: (() -> Void)?
    public weak var associatedBody: HTTPIncomingBody?
    
    public init(status: Int, headers: [(String, String)], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
    
    public func appendBody(_ data: Data) {
        bodyLock.lock()
        body.append(data)
        let callback = onDataAvailable
        let body = associatedBody
        bodyLock.unlock()
        
        if let body = body {
            body.signalDataAvailable()
        } else {
            callback?()
        }
    }
    
    public func markStreamComplete() {
        bodyLock.lock()
        streamComplete = true
        bodyLock.unlock()
        Log.http.debug("Stream marked complete, total body size: \(self.body.count) bytes")
        
        if let body = associatedBody {
            body.signalDataAvailable()
        } else {
            onDataAvailable?()
        }
    }
    
    public func readBody(maxBytes: Int) -> Data {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        
        let available = body.count - bodyReadOffset
        let toRead = min(maxBytes, available)
        
        if toRead <= 0 {
            return Data()
        }
        
        let chunk = body.subdata(in: bodyReadOffset..<(bodyReadOffset + toRead))
        bodyReadOffset += toRead
        return chunk
    }
    
    public var hasUnreadData: Bool {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        return bodyReadOffset < body.count
    }
}

/// Incoming HTTP body (for responses)
public class HTTPIncomingBody: NSObject {
    public var response: HTTPIncomingResponse?
    public var inputStreamHandle: Int32?
    public var streamPollables: [StreamPollable] = []
    private let pollablesLock = NSLock()
    
    public init(response: HTTPIncomingResponse) {
        self.response = response
        super.init()
        response.associatedBody = self
        response.onDataAvailable = { [weak self] in
            self?.signalDataAvailable()
        }
    }
    
    /// Convenience initializer for server-side incoming request bodies
    public convenience init(data: Data) {
        let response = HTTPIncomingResponse(status: 0, headers: [], body: data)
        response.streamComplete = true
        self.init(response: response)
    }
    
    public func addPollable(_ pollable: StreamPollable) {
        pollablesLock.lock()
        streamPollables.append(pollable)
        pollablesLock.unlock()
        
        if let response = response, (response.hasUnreadData || response.streamComplete) {
            pollable.signalDataAvailable()
        }
    }
    
    public func signalDataAvailable() {
        pollablesLock.lock()
        let pollables = streamPollables
        pollablesLock.unlock()
        
        for pollable in pollables {
            pollable.signalDataAvailable()
        }
    }
}

/// Future for async HTTP response
public class FutureIncomingResponse: NSObject {
    public var response: HTTPIncomingResponse?
    public var error: String?
    public let semaphore = DispatchSemaphore(value: 0)
    public var cachedPollableHandle: Int32?
    
    public override init() {
        super.init()
    }
    
    public func signalReady() {
        semaphore.signal()
    }
    
    public func waitForReady(timeout: TimeInterval) -> Bool {
        return semaphore.wait(timeout: .now() + timeout) == .success
    }
}
