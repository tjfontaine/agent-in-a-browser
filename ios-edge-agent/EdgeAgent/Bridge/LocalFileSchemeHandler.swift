import WebKit
import Foundation

/// Custom URL scheme handler that serves local files from the app bundle without CORS restrictions
/// This allows ES modules to import from file:// URLs in WKWebView
class LocalFileSchemeHandler: NSObject, WKURLSchemeHandler {
    
    private let baseDirectory: URL
    
    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
        super.init()
    }
    
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "LocalFileSchemeHandler", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"]))
            return
        }
        
        // Convert custom scheme URL to file path
        // local://web-runtime.html -> web-runtime.html
        // local://web-headless-agent/shims/foo.js -> web-headless-agent/shims/foo.js
        // The host + path together form the file path
        var relativePath = ""
        if let host = requestURL.host {
            relativePath = host
        }
        if !requestURL.path.isEmpty && requestURL.path != "/" {
            relativePath += requestURL.path
        }
        
        let fileURL = baseDirectory.appendingPathComponent(relativePath)
        
        print("[LocalFileSchemeHandler] Loading: \(requestURL) -> \(fileURL)")
        
        do {
            let data = try Data(contentsOf: fileURL)
            
            // Determine MIME type
            let mimeType = mimeType(for: fileURL.pathExtension)
            
            // Create HTTP response with CORS headers to allow ES module imports
            let headers: [String: String] = [
                "Content-Type": mimeType,
                "Content-Length": "\(data.count)",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Cache-Control": "no-cache"
            ]
            
            let response = HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
            
        } catch {
            print("[LocalFileSchemeHandler] Error loading \(fileURL): \(error)")
            urlSchemeTask.didFailWithError(error)
        }
    }
    
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Nothing to clean up
    }
    
    private func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": return "text/html"
        case "js": return "application/javascript"
        case "mjs": return "application/javascript"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "css": return "text/css"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}
