import Foundation
import WasmKit
import WasmParser
import OSLog
import Network

// MARK: - WasmKit Host Errors

enum WasmKitHostError: Error, LocalizedError {
    case wasmNotFound
    case notLoaded
    case exportNotFound(String)
    case invalidResult
    case invalidString
    case allocationFailed
    case operationFailed(String)
    
    var errorDescription: String? {
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

// MARK: - Resource Registry

/// Resource registry for WASI handles - shared across all WASM hosts
final class ResourceRegistry: @unchecked Sendable {
    private var nextHandle: Int32 = 1
    private var resources: [Int32: AnyObject] = [:]
    private let lock = NSLock()
    
    func register(_ resource: AnyObject) -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        
        let handle = nextHandle
        nextHandle += 1
        resources[handle] = resource
        return handle
    }
    
    func get<T: AnyObject>(_ handle: Int32) -> T? {
        lock.lock()
        defer { lock.unlock() }
        return resources[handle] as? T
    }
    
    func drop(_ handle: Int32) {
        lock.lock()
        defer { lock.unlock() }
        resources.removeValue(forKey: handle)
    }
}

// MARK: - HTTP Types

class HTTPFields: NSObject {
    var entries: [(String, String)] = []
    
    func append(name: String, value: String) {
        entries.append((name, value))
    }
    
    func set(name: String, value: String) {
        // Remove existing entries with same name and add new one
        entries.removeAll { $0.0.lowercased() == name.lowercased() }
        entries.append((name, value))
    }
}

class HTTPRequestOptions: NSObject {
    var connectTimeout: UInt64?
    var firstByteTimeout: UInt64?
    var betweenBytesTimeout: UInt64?
}

/// Incoming HTTP request (server-side)
class HTTPIncomingRequest: NSObject {
    var method: String
    var pathWithQuery: String?
    var headers: HTTPFields
    var body: Data
    var bodyConsumed = false
    
    init(method: String = "GET", path: String? = nil, headers: HTTPFields = HTTPFields(), body: Data = Data()) {
        self.method = method
        self.pathWithQuery = path
        self.headers = headers
        self.body = body
        super.init()
    }
}

/// Response out-param for sending responses back (server-side)
class ResponseOutparam: NSObject {
    var responseSet = false
    var response: HTTPOutgoingResponseResource?
    var error: String?
}

/// Future trailers resource (HTTP/2 trailer headers)
class FutureTrailers: NSObject {
    var trailers: HTTPFields?
    var complete = false
}

class HTTPOutgoingRequest: NSObject {
    var headersHandle: Int32
    var method: String = "GET"
    var scheme: String = "https"
    var authority: String = ""
    var path: String = "/"
    var outgoingBodyHandle: Int32?
    /// Direct reference to the body (survives registry drops)
    var outgoingBody: HTTPOutgoingBody?
    
    init(headers: UInt32) {
        self.headersHandle = Int32(bitPattern: headers)
        super.init()
    }
}

class HTTPOutgoingBody: NSObject {
    var data = Data()
    var outputStreamHandle: Int32?
    var finished = false
    
    func write(_ chunk: Data) {
        data.append(chunk)
    }
    
    func getData() -> Data {
        return data
    }
}

/// Resource for outgoing HTTP responses (server-side)
class HTTPOutgoingResponseResource: NSObject {
    var headersHandle: Int32
    var statusCode: Int = 200
    var bodyHandle: Int32?
    var outgoingBody: HTTPOutgoingBody?  // Direct reference to survive registry drops
    
    init(headersHandle: Int32) {
        self.headersHandle = headersHandle
    }
}

class HTTPIncomingResponse: NSObject {
    let status: Int
    let headers: [(String, String)]
    var body: Data
    var bodyConsumed = false
    var bodyReadOffset = 0
    var streamComplete = false
    private let bodyLock = NSLock()
    
    var onDataAvailable: (() -> Void)?
    weak var associatedBody: HTTPIncomingBody?
    
    init(status: Int, headers: [(String, String)], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
    
    func appendBody(_ data: Data) {
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
    
    func markStreamComplete() {
        bodyLock.lock()
        streamComplete = true
        bodyLock.unlock()
        Log.http.debug("Stream marked complete, total body size: \(body.count) bytes")
        
        if let body = associatedBody {
            body.signalDataAvailable()
        } else {
            onDataAvailable?()
        }
    }
    
    func readBody(maxBytes: Int) -> Data {
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
    
    var hasUnreadData: Bool {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        return bodyReadOffset < body.count
    }
}

class HTTPIncomingBody: NSObject {
    var response: HTTPIncomingResponse?
    var inputStreamHandle: Int32?
    var streamPollables: [StreamPollable] = []
    private let pollablesLock = NSLock()
    
    init(response: HTTPIncomingResponse) {
        self.response = response
        super.init()
        response.associatedBody = self
        response.onDataAvailable = { [weak self] in
            self?.signalDataAvailable()
        }
    }
    
    /// Convenience initializer for server-side incoming request bodies
    convenience init(data: Data) {
        let response = HTTPIncomingResponse(status: 0, headers: [], body: data)
        response.streamComplete = true
        self.init(response: response)
    }
    
    func addPollable(_ pollable: StreamPollable) {
        pollablesLock.lock()
        streamPollables.append(pollable)
        pollablesLock.unlock()
        
        if let response = response, (response.hasUnreadData || response.streamComplete) {
            pollable.signalDataAvailable()
        }
    }
    
    func signalDataAvailable() {
        pollablesLock.lock()
        let pollables = streamPollables
        pollablesLock.unlock()
        
        for pollable in pollables {
            pollable.signalDataAvailable()
        }
    }
}

class FutureIncomingResponse: NSObject {
    var response: HTTPIncomingResponse?
    var error: String?
    let semaphore = DispatchSemaphore(value: 0)
    var cachedPollableHandle: Int32?
    
    func signalReady() {
        semaphore.signal()
    }
    
    func waitForReady(timeout: TimeInterval) -> Bool {
        return semaphore.wait(timeout: .now() + timeout) == .success
    }
}

// MARK: - Pollable Types

/// Pollable for HTTP futures (used by wasi:io/poll)
/// Alias: HTTPPollable
class FuturePollable: NSObject {
    weak var future: FutureIncomingResponse?
    
    init(future: FutureIncomingResponse) {
        self.future = future
    }
    
    var isReady: Bool {
        return future?.response != nil || future?.error != nil
    }
    
    func block(timeout: TimeInterval = 30) {
        guard let future = future else { return }
        _ = future.waitForReady(timeout: timeout)
    }
}

class TimePollable: NSObject {
    let createdAt = Date()
    let nanoseconds: UInt64
    
    init(nanoseconds: UInt64) {
        self.nanoseconds = nanoseconds
    }
    
    var isReady: Bool {
        let elapsed = Date().timeIntervalSince(createdAt) * 1_000_000_000
        return UInt64(elapsed) >= nanoseconds
    }
}

class StreamPollable: NSObject {
    weak var response: HTTPIncomingResponse?
    let streamHandle: Int32
    let semaphore = DispatchSemaphore(value: 0)
    private var signaled = false
    private let lock = NSLock()
    
    init(response: HTTPIncomingResponse, streamHandle: Int32) {
        self.response = response
        self.streamHandle = streamHandle
        super.init()
    }
    
    var isReady: Bool {
        guard let response = response else { return true }
        return response.hasUnreadData || response.streamComplete
    }
    
    func signalDataAvailable() {
        lock.lock()
        if !signaled {
            signaled = true
            semaphore.signal()
        }
        lock.unlock()
    }
    
    func block(timeout: TimeInterval) {
        guard let response = response else { return }
        
        if response.hasUnreadData || response.streamComplete {
            return
        }
        
        _ = semaphore.wait(timeout: .now() + timeout)
    }
    
    func resetForNextWait() {
        lock.lock()
        signaled = false
        lock.unlock()
    }
}

// MARK: - WASI IO Streams

class WASIInputStream: NSObject {
    var body: HTTPIncomingBody?
    
    init(body: HTTPIncomingBody) {
        self.body = body
    }
    
    func read(maxBytes: Int) -> Data? {
        return body?.response?.readBody(maxBytes: maxBytes)
    }
    
    /// Read data, blocking until data is available or stream is complete
    func blockingRead(maxBytes: Int) -> Data {
        return body?.response?.readBody(maxBytes: maxBytes) ?? Data()
    }
    
    /// Check if stream has reached EOF
    var isEOF: Bool {
        guard let response = body?.response else { return true }
        return response.streamComplete && !response.hasUnreadData
    }
}

class WASIOutputStream: NSObject {
    var body: HTTPOutgoingBody?
    
    init(body: HTTPOutgoingBody) {
        self.body = body
    }
    
    func write(_ data: Data) {
        body?.write(data)
    }
}

class StderrOutputStream: NSObject {
    func write(_ data: Data) {
        if let str = String(data: data, encoding: .utf8) {
            Log.wasi.info("[stderr] \(str.trimmingCharacters(in: .newlines))")
        }
    }
}

// MARK: - HTTP Request Manager

/// Manages async HTTP requests using URLSession - shared by all WASM hosts
final class HTTPRequestManager: @unchecked Sendable {
    private let session: URLSession
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }
    
    func performRequest(
        method: String,
        url: String,
        headers: [(String, String)],
        body: Data?,
        future: FutureIncomingResponse,
        resources: ResourceRegistry
    ) {
        // Rewrite wasm:// URLs to localhost MCP server for native runtime
        var effectiveURL = url
        if url.hasPrefix("wasm://") {
            effectiveURL = "http://127.0.0.1:9292/"
            if let query = URL(string: url)?.query {
                effectiveURL += "?\(query)"
            }
            Log.http.info(" Routing wasm:// to MCP server (127.0.0.1:9292)")
        }
        
        guard let requestURL = URL(string: effectiveURL) else {
            future.error = "Invalid URL: \(url)"
            return
        }
        
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        
        for (name, value) in headers {
            request.addValue(value, forHTTPHeaderField: name)
        }
        
        if let body = body {
            request.httpBody = body
        }
        
        Log.http.debug("Starting request: \(method) \(effectiveURL)")
        
        let isSSE = headers.contains { $0.0.lowercased() == "accept" && $0.1 == "text/event-stream" }
        
        if isSSE {
            Log.http.debug("Using streaming delegate for SSE request")
            let delegate = StreamingDelegate(future: future)
            let delegateSession = URLSession(configuration: session.configuration, delegate: delegate, delegateQueue: nil)
            delegate.session = delegateSession
            let task = delegateSession.dataTask(with: request)
            task.resume()
        } else {
            let ephemeralConfig = URLSessionConfiguration.ephemeral
            ephemeralConfig.timeoutIntervalForRequest = 60
            let ephemeralSession = URLSession(configuration: ephemeralConfig)
            
            var ephemeralRequest = request
            ephemeralRequest.addValue("close", forHTTPHeaderField: "Connection")
            
            let task = ephemeralSession.dataTask(with: ephemeralRequest) { data, response, error in
                defer { ephemeralSession.finishTasksAndInvalidate() }
                
                if let error = error {
                    Log.http.error("Request failed: \(error.localizedDescription)")
                    future.error = error.localizedDescription
                    future.signalReady()
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    future.error = "Invalid response type"
                    future.signalReady()
                    return
                }
                
                Log.http.debug("Response: status=\(httpResponse.statusCode), body=\(data?.count ?? 0) bytes")
                
                var headers: [(String, String)] = []
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyStr = key as? String, let valueStr = value as? String {
                        headers.append((keyStr.lowercased(), valueStr))
                    }
                }
                
                let incomingResponse = HTTPIncomingResponse(
                    status: httpResponse.statusCode,
                    headers: headers,
                    body: data ?? Data()
                )
                incomingResponse.streamComplete = true
                
                future.response = incomingResponse
                future.signalReady()
            }
            task.resume()
        }
    }
}

/// Streaming delegate for chunked HTTP responses (SSE)
class StreamingDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var future: FutureIncomingResponse?
    var incomingResponse: HTTPIncomingResponse?
    var session: URLSession?
    private var receivedData = Data()
    private var response: HTTPURLResponse?
    private var headersSignaled = false
    private let dataLock = NSLock()
    
    init(future: FutureIncomingResponse) {
        self.future = future
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        
        if let httpResponse = response as? HTTPURLResponse {
            Log.http.debug("Headers received, status=\(httpResponse.statusCode)")
            
            var headers: [(String, String)] = []
            for (key, value) in httpResponse.allHeaderFields {
                if let keyStr = key as? String, let valueStr = value as? String {
                    headers.append((keyStr.lowercased(), valueStr))
                }
            }
            
            let httpIncomingResponse = HTTPIncomingResponse(
                status: httpResponse.statusCode,
                headers: headers,
                body: Data()
            )
            
            self.incomingResponse = httpIncomingResponse
            future?.response = httpIncomingResponse
            
            headersSignaled = true
            future?.signalReady()
        }
        
        completionHandler(.allow)
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataLock.lock()
        receivedData.append(data)
        incomingResponse?.appendBody(data)
        dataLock.unlock()
        
        if receivedData.count % 1000 < data.count {
            Log.http.debug("Streaming: \(receivedData.count) bytes received")
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            self.session?.invalidateAndCancel()
            self.session = nil
        }
        
        if let error = error {
            Log.http.debug("Stream error: \(error)")
            future?.error = error.localizedDescription
            if !headersSignaled { future?.signalReady() }
            return
        }
        
        Log.http.debug("Stream completed, total: \(receivedData.count) bytes")
        
        if let httpResponse = response, httpResponse.statusCode >= 400 {
            let bodyStr = String(data: receivedData, encoding: .utf8) ?? "binary"
            Log.http.debug("Error response body: \(bodyStr)")
        }
        
        self.incomingResponse?.markStreamComplete()
        
        if !headersSignaled { future?.signalReady() }
    }
}

// MARK: - Type Aliases for Backward Compatibility

/// HTTPPollable is used in NativeAgentHost for polling HTTP futures
typealias HTTPPollable = FuturePollable

/// DurationPollable is used for monotonic clock polling
typealias DurationPollable = TimePollable

