import WebKit
import OSLog

/// Forwards JavaScript console.log/warn/error to OSLog
/// 
/// Usage:
/// ```swift
/// let consoleHandler = JSConsoleHandler()
/// webView.configuration.userContentController.add(consoleHandler, name: "consoleLog")
/// webView.configuration.userContentController.add(consoleHandler, name: "consoleWarn")
/// webView.configuration.userContentController.add(consoleHandler, name: "consoleError")
/// webView.configuration.userContentController.addUserScript(consoleHandler.injectionScript)
/// ```
class JSConsoleHandler: NSObject, WKScriptMessageHandler {
    
    /// JavaScript to inject that forwards console methods to native
    var injectionScript: WKUserScript {
        let js = """
        (function() {
            const originalLog = console.log;
            const originalWarn = console.warn;
            const originalError = console.error;
            
            function stringify(args) {
                return Array.from(args).map(arg => {
                    if (typeof arg === 'object') {
                        try { return JSON.stringify(arg); }
                        catch { return String(arg); }
                    }
                    return String(arg);
                }).join(' ');
            }
            
            console.log = function(...args) {
                window.webkit?.messageHandlers?.consoleLog?.postMessage(stringify(args));
                originalLog.apply(console, args);
            };
            
            console.warn = function(...args) {
                window.webkit?.messageHandlers?.consoleWarn?.postMessage(stringify(args));
                originalWarn.apply(console, args);
            };
            
            console.error = function(...args) {
                window.webkit?.messageHandlers?.consoleError?.postMessage(stringify(args));
                originalError.apply(console, args);
            };
        })();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }
    
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        
        switch message.name {
        case "consoleLog":
            Log.ui.info("[JS] \(body)")
        case "consoleWarn":
            Log.ui.warning("[JS] \(body)")
        case "consoleError":
            Log.ui.error("[JS] \(body)")
        default:
            Log.ui.debug("[JS:\(message.name)] \(body)")
        }
    }
}

// MARK: - WKWebView Extension for easy console forwarding

extension WKWebViewConfiguration {
    /// Enable JavaScript console.log forwarding to OSLog
    func enableConsoleLogging() {
        let handler = JSConsoleHandler()
        userContentController.add(handler, name: "consoleLog")
        userContentController.add(handler, name: "consoleWarn")
        userContentController.add(handler, name: "consoleError")
        userContentController.addUserScript(handler.injectionScript)
    }
}
