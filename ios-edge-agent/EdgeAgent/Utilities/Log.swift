import Foundation
import OSLog

/// Timestamp formatter - cached for performance
private let timestampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter
}()

/// Current timestamp string
private func ts() -> String {
    timestampFormatter.string(from: Date())
}

/// Unified logging for EdgeAgent using Apple's OSLog Logger API
/// All logs include timestamps and category names for easy debugging.
/// Format: [HH:mm:ss.SSS] [Category] message
/// Usage: Log.http.info("Request started")
enum Log {
    private static let subsystem = Bundle.main.bundleIdentifier ?? "com.edgeagent"
    
    // MARK: - Core Loggers (with timestamps and category names)
    
    /// HTTP networking (URLSession requests/responses)
    static let http = TimestampedLogger(Logger(subsystem: subsystem, category: "HTTP"), name: "HTTP")
    
    /// WASI runtime operations (memory, I/O, polling)
    static let wasi = TimestampedLogger(Logger(subsystem: subsystem, category: "WASI"), name: "WASI")
    
    /// WASI-HTTP specific operations
    static let wasiHttp = TimestampedLogger(Logger(subsystem: subsystem, category: "WASI-HTTP"), name: "WASI-HTTP")
    
    /// MCP server and protocol handling
    static let mcp = TimestampedLogger(Logger(subsystem: subsystem, category: "MCP"), name: "MCP")
    
    /// Native agent host and WASM runtime
    static let agent = TimestampedLogger(Logger(subsystem: subsystem, category: "Agent"), name: "Agent")
    
    /// UI rendering and component updates
    static let ui = TimestampedLogger(Logger(subsystem: subsystem, category: "UI"), name: "UI")
    
    /// App lifecycle and view events
    static let app = TimestampedLogger(Logger(subsystem: subsystem, category: "App"), name: "App")
}

// MARK: - Timestamped Logger Wrapper

/// Logger wrapper that prepends timestamps and category names to all log messages
/// Format: [HH:mm:ss.SSS] [Category] message
struct TimestampedLogger {
    private let logger: Logger
    private let name: String
    
    init(_ logger: Logger, name: String) {
        self.logger = logger
        self.name = name
    }
    
    func debug(_ message: String) {
        logger.debug("[\(ts())] [\(self.name)] \(message)")
    }
    
    func info(_ message: String) {
        logger.info("[\(ts())] [\(self.name)] \(message)")
    }
    
    func notice(_ message: String) {
        logger.notice("[\(ts())] [\(self.name)] \(message)")
    }
    
    func warning(_ message: String) {
        logger.warning("[\(ts())] [\(self.name)] \(message)")
    }
    
    func error(_ message: String) {
        logger.error("[\(ts())] [\(self.name)] \(message)")
    }
    
    func critical(_ message: String) {
        logger.critical("[\(ts())] [\(self.name)] \(message)")
    }
}
