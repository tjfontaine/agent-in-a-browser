import Foundation

// MARK: - HTTP Request Protocol

/// Protocol for performing HTTP requests - enables testing and alternative implementations
public protocol HTTPRequestPerforming: Sendable {
    func performRequest(
        method: String,
        url: String,
        headers: [(String, String)],
        body: Data?,
        future: FutureIncomingResponse,
        resources: ResourceRegistry
    )
}

// MARK: - HTTP Request Manager

/// Manages async HTTP requests using URLSession - shared by all WASM hosts
public final class HTTPRequestManager: NSObject, HTTPRequestPerforming, @unchecked Sendable {
    private let session: URLSession
    
    public override init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
        super.init()
    }
    
    public func performRequest(
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
                
                // Log error response bodies for debugging
                if httpResponse.statusCode >= 400, let data = data {
                    let bodyStr = String(data: data, encoding: .utf8) ?? "binary data"
                    Log.http.error("Error response body: \(bodyStr)")
                }
                
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

// MARK: - Streaming Delegate

/// Streaming delegate for chunked HTTP responses (SSE)
public class StreamingDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
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
    
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
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
    
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataLock.lock()
        receivedData.append(data)
        incomingResponse?.appendBody(data)
        dataLock.unlock()
        
        if receivedData.count % 1000 < data.count {
            Log.http.debug("Streaming: \(self.receivedData.count) bytes received")
        }
    }
    
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
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
        
        Log.http.debug("Stream completed, total: \(self.receivedData.count) bytes")
        
        if let httpResponse = response, httpResponse.statusCode >= 400 {
            let bodyStr = String(data: receivedData, encoding: .utf8) ?? "binary"
            Log.http.debug("Error response body: \(bodyStr)")
        }
        
        self.incomingResponse?.markStreamComplete()
        
        if !headersSignaled { future?.signalReady() }
    }
}
