import WebKit
import Combine

/// Bridge between SwiftUI and the WASM agent running in hidden WKWebView
@MainActor
class AgentBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    /// Singleton instance to ensure only one WebView/agent exists
    static let shared = AgentBridge()
    
    @Published var events: [AgentEvent] = []
    @Published var isReady = false
    @Published var currentStreamText = ""
    
    private var webView: WKWebView!
    private var agentHandle: Int?
    private let instanceId = UUID().uuidString.prefix(8) // Track which instance is which
    
    private override init() {
        super.init()
        print("[AgentBridge:\(instanceId)] init() called (singleton)")
        setupWebView()
    }
    private var schemeHandler: LocalFileSchemeHandler?
    
    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "agent")
        config.userContentController.add(self, name: "console") // For JS console.log forwarding
        
        // Enable developer extras for debugging
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        // Register custom URL scheme handler to serve local files with CORS headers
        // This is required for ES module imports to work in WKWebView
        if let webRuntimeDir = Bundle.main.url(forResource: "WebRuntime", withExtension: nil) {
            schemeHandler = LocalFileSchemeHandler(baseDirectory: webRuntimeDir)
            config.setURLSchemeHandler(schemeHandler, forURLScheme: "local")
            print("[AgentBridge] Registered local:// scheme handler for: \(webRuntimeDir)")
        }
        
        webView = WKWebView(frame: .zero, configuration: config)
        webView.alpha = 0
        
        // Load web runtime using custom scheme (required for ES module CORS)
        let localURL = URL(string: "local://web-runtime.html")!
        print("[AgentBridge] Loading: \(localURL)")
        webView.load(URLRequest(url: localURL))
    }
    
    /// Attach WebView to window (required for JS execution)
    func attachToWindow() {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first else {
            print("[AgentBridge] WARNING: No window available to attach WebView")
            return
        }
        window.addSubview(webView)
    }
    
    /// Create agent with configuration
    func createAgent(config: AgentConfig) {
        guard isReady else {
            print("[AgentBridge] Not ready, deferring agent creation")
            return
        }
        
        do {
            let json = try JSONEncoder().encode(config)
            let jsonStr = String(data: json, encoding: .utf8)!
            print("[AgentBridge:\(instanceId)] Creating agent with config: \(jsonStr)")
            let escaped = jsonStr.replacingOccurrences(of: "\\", with: "\\\\")
                                 .replacingOccurrences(of: "'", with: "\\'")
            print("[AgentBridge:\(instanceId)] Calling window.agentCreate...")
            webView.evaluateJavaScript("window.agentCreate('\(escaped)')") { _, error in
                if let error = error {
                    print("[AgentBridge] createAgent error: \(error)")
                } else {
                    print("[AgentBridge] agentCreate call succeeded")
                }
            }
        } catch {
            print("[AgentBridge] Failed to encode config: \(error)")
        }
    }
    
    /// Send message to agent
    func send(_ message: String) {
        print("[AgentBridge:\(instanceId)] send() called with message length \(message.count)")
        let escaped = message.replacingOccurrences(of: "\\", with: "\\\\")
                             .replacingOccurrences(of: "'", with: "\\'")
                             .replacingOccurrences(of: "\n", with: "\\n")
        webView.evaluateJavaScript("window.agentSend('\(escaped)')") { _, error in
            if let error = error {
                print("[AgentBridge] send error: \(error)")
            }
        }
    }
    
    /// Cancel current operation
    func cancel() {
        webView.evaluateJavaScript("window.agentCancel()") { _, _ in }
    }
    
    /// Clear conversation history
    func clearHistory() {
        events.removeAll()
        currentStreamText = ""
        webView.evaluateJavaScript("window.agentClearHistory()") { _, _ in }
    }
    
    /// Get list of available providers from WASM
    func listProviders() async -> [ProviderInfo] {
        guard isReady else { return [] }
        
        do {
            let result = try await webView.evaluateJavaScript("window.listProviders()")
            if let jsonString = result as? String,
               let data = jsonString.data(using: .utf8) {
                return try JSONDecoder().decode([ProviderInfo].self, from: data)
            }
        } catch {
            print("[AgentBridge] listProviders error: \(error)")
        }
        return []
    }
    
    /// Get list of models for a provider from WASM
    func listModels(providerId: String) async -> [ModelInfo] {
        guard isReady else { return [] }
        
        let escaped = providerId.replacingOccurrences(of: "'", with: "\\'")
        do {
            let result = try await webView.evaluateJavaScript("window.listModels('\(escaped)')")
            if let jsonString = result as? String,
               let data = jsonString.data(using: .utf8) {
                return try JSONDecoder().decode([ModelInfo].self, from: data)
            }
        } catch {
            print("[AgentBridge] listModels error: \(error)")
        }
        return []
    }
    
    // MARK: - WKScriptMessageHandler
    
    nonisolated func userContentController(_ controller: WKUserContentController,
                                            didReceive message: WKScriptMessage) {
        Task { @MainActor in
            if message.name == "console" {
                handleConsoleMessage(message)
            } else {
                handleMessage(message)
            }
        }
    }
    
    /// Handle JS console.log forwarded from WKWebView
    private func handleConsoleMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let level = body["level"] as? String,
              let text = body["message"] as? String else { return }
        
        print("[JS:\(level.uppercased())] \(text)")
    }
    
    private func handleMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        
        switch type {
        case "ready":
            isReady = true
            attachToWindow()
            print("[AgentBridge] WebView ready")
            
        case "handle":
            agentHandle = body["handle"] as? Int
            print("[AgentBridge] Agent created with handle: \(agentHandle ?? -1)")
            
        case "event":
            if let eventDict = body["event"] as? [String: Any],
               let event = AgentEvent.from(eventDict) {
                events.append(event)
                
                // Track streaming text
                switch event {
                case .streamStart:
                    currentStreamText = ""
                case .chunk(let text):
                    currentStreamText = text
                case .complete(let text):
                    currentStreamText = text
                default:
                    break
                }
            }
            
        case "error":
            let error = body["error"] as? String ?? "Unknown error"
            print("[AgentBridge] Error: \(error)")
            events.append(.error(error))
            
        case "http":
            handleHTTPRequest(body)
            
        default:
            print("[AgentBridge] Unknown message type: \(type)")
        }
    }
    
    // MARK: - HTTP Bridge
    
    /// Handle HTTP request from WASM by making URLSession request and calling back to JS
    private func handleHTTPRequest(_ message: [String: Any]) {
        guard let id = message["id"] as? String,
              let method = message["method"] as? String,
              let urlString = message["url"] as? String,
              let url = URL(string: urlString) else {
            print("[AgentBridge] Invalid HTTP request message")
            return
        }
        
        print("[AgentBridge] HTTP request: \(method) \(urlString)")
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        
        // Set headers
        if let headers = message["headers"] as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
            print("[AgentBridge] HTTP headers: \(headers)")
        } else {
            print("[AgentBridge] HTTP headers: none")
        }
        
        // Set body
        if let bodyArray = message["body"] as? [Int] {
            let bodyData = Data(bodyArray.map { UInt8($0) })
            request.httpBody = bodyData
            if let bodyStr = String(data: bodyData, encoding: .utf8) {
                print("[AgentBridge] HTTP body (\(bodyData.count) bytes): \(bodyStr.prefix(500))...")
            }
        }
        
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    await callHttpCallback(id: id, error: "Invalid response type")
                    return
                }
                
                print("[AgentBridge] HTTP response: \(httpResponse.statusCode) (URL: \(httpResponse.url?.absoluteString ?? "nil"))")
                
                // Log response body on error status codes
                if httpResponse.statusCode >= 400 {
                    if let responseBody = String(data: data, encoding: .utf8) {
                        print("[AgentBridge] HTTP error body: \(responseBody)")
                    }
                }
                
                // Build headers array
                var headers: [[Any]] = []
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyStr = key as? String, let valueStr = value as? String {
                        headers.append([keyStr.lowercased(), Array(valueStr.utf8)])
                    }
                }
                
                // Call back to JS with response
                await callHttpCallback(
                    id: id,
                    status: httpResponse.statusCode,
                    headers: headers,
                    body: Array(data)
                )
            } catch {
                print("[AgentBridge] HTTP error: \(error)")
                await callHttpCallback(id: id, error: error.localizedDescription)
            }
        }
    }
    
    private func callHttpCallback(id: String, status: Int, headers: [[Any]], body: [UInt8]) async {
        do {
            let responseDict: [String: Any] = [
                "status": status,
                "headers": headers,
                "body": body
            ]
            let jsonData = try JSONSerialization.data(withJSONObject: responseDict)
            let jsonString = String(data: jsonData, encoding: .utf8)!
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            
            let js = "window._httpCallback('\(id)', '\(jsonString)')"
            await MainActor.run {
                webView.evaluateJavaScript(js) { _, error in
                    if let error = error {
                        print("[AgentBridge] httpCallback error: \(error)")
                    }
                }
            }
        } catch {
            print("[AgentBridge] Failed to serialize response: \(error)")
        }
    }
    
    private func callHttpCallback(id: String, error: String) async {
        let escaped = error.replacingOccurrences(of: "'", with: "\\'")
        let js = "window._httpCallback('\(id)', '{\"error\": \"\\(escaped)\"}')"
        await MainActor.run {
            webView.evaluateJavaScript(js) { _, _ in }
        }
    }
}
