/// Log.swift
/// Centralized logging infrastructure for WASIP2Harness

import OSLog

/// Centralized logging categories for WASM/WASI operations
public enum Log {
    public static let wasi = Logger(subsystem: "WASIP2Harness", category: "WASI")
    public static let wasiHttp = Logger(subsystem: "WASIP2Harness", category: "WASI-HTTP")
    public static let http = Logger(subsystem: "WASIP2Harness", category: "HTTP")
    public static let agent = Logger(subsystem: "WASIP2Harness", category: "Agent")
    public static let mcp = Logger(subsystem: "WASIP2Harness", category: "MCP")
}
