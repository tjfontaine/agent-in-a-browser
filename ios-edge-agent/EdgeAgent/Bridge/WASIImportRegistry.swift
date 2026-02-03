/// WASIImportRegistry.swift
/// Central registry of all WASI imports declared by providers.
/// This file enables compile-time validation by comparing against GeneratedWASMImports.

import Foundation

// MARK: - Import Registry

/// Central registry mapping providers to their declared imports.
/// Add entries here as providers are implemented.
/// The build script + unit test validate coverage against WASM requirements.
enum WASIImportRegistry {
    
    // MARK: - IoPollProvider
    static let ioPoll: Set<String> = [
        // 0.2.9
        "wasi:io/poll@0.2.9.[method]pollable.block",
        "wasi:io/poll@0.2.9.[method]pollable.ready",
        "wasi:io/poll@0.2.9.[resource-drop]pollable",
        // 0.2.4
        "wasi:io/poll@0.2.4.[method]pollable.block",
        "wasi:io/poll@0.2.4.[resource-drop]pollable",
        // 0.2.0
        "wasi:io/poll@0.2.0.[resource-drop]pollable",
    ]
    
    // MARK: - IoStreamsProvider
    static let ioStreams: Set<String> = [
        // 0.2.9
        "wasi:io/streams@0.2.9.[method]input-stream.subscribe",
        "wasi:io/streams@0.2.9.[method]input-stream.read",
        "wasi:io/streams@0.2.9.[method]input-stream.blocking-read",
        "wasi:io/streams@0.2.9.[method]output-stream.blocking-write-and-flush",
        "wasi:io/streams@0.2.9.[method]output-stream.subscribe",
        "wasi:io/streams@0.2.9.[method]output-stream.write",
        "wasi:io/streams@0.2.9.[resource-drop]input-stream",
        "wasi:io/streams@0.2.9.[resource-drop]output-stream",
        // 0.2.4
        "wasi:io/streams@0.2.4.[method]output-stream.blocking-write-and-flush",
        "wasi:io/streams@0.2.4.[resource-drop]output-stream",
        // 0.2.0
        "wasi:io/streams@0.2.0.[resource-drop]input-stream",
        "wasi:io/streams@0.2.0.[resource-drop]output-stream",
    ]
    
    // MARK: - IoErrorProvider
    static let ioError: Set<String> = [
        "wasi:io/error@0.2.9.[resource-drop]error",
        "wasi:io/error@0.2.4.[method]error.to-debug-string",
        "wasi:io/error@0.2.4.[resource-drop]error",
    ]
    
    // MARK: - HttpTypesProvider
    static let httpTypes: Set<String> = [
        "wasi:http/types@0.2.9.[constructor]fields",
        "wasi:http/types@0.2.9.[constructor]request-options",
        "wasi:http/types@0.2.9.[constructor]outgoing-request",
        "wasi:http/types@0.2.9.[constructor]outgoing-response",
        "wasi:http/types@0.2.9.[method]fields.append",
        "wasi:http/types@0.2.9.[method]fields.entries",
        "wasi:http/types@0.2.9.[method]fields.set",
        "wasi:http/types@0.2.9.[method]future-incoming-response.get",
        "wasi:http/types@0.2.9.[method]future-incoming-response.subscribe",
        "wasi:http/types@0.2.9.[method]incoming-body.stream",
        "wasi:http/types@0.2.9.[method]incoming-request.consume",
        "wasi:http/types@0.2.9.[method]incoming-request.headers",
        "wasi:http/types@0.2.9.[method]incoming-request.path-with-query",
        "wasi:http/types@0.2.9.[method]incoming-response.consume",
        "wasi:http/types@0.2.9.[method]incoming-response.headers",
        "wasi:http/types@0.2.9.[method]incoming-response.status",
        "wasi:http/types@0.2.9.[method]outgoing-body.write",
        "wasi:http/types@0.2.9.[method]outgoing-request.body",
        "wasi:http/types@0.2.9.[method]outgoing-request.set-authority",
        "wasi:http/types@0.2.9.[method]outgoing-request.set-method",
        "wasi:http/types@0.2.9.[method]outgoing-request.set-path-with-query",
        "wasi:http/types@0.2.9.[method]outgoing-request.set-scheme",
        "wasi:http/types@0.2.9.[method]outgoing-response.body",
        "wasi:http/types@0.2.9.[method]outgoing-response.set-status-code",
        "wasi:http/types@0.2.9.[resource-drop]fields",
        "wasi:http/types@0.2.9.[resource-drop]future-incoming-response",
        "wasi:http/types@0.2.9.[resource-drop]future-trailers",
        "wasi:http/types@0.2.9.[resource-drop]incoming-body",
        "wasi:http/types@0.2.9.[resource-drop]incoming-request",
        "wasi:http/types@0.2.9.[resource-drop]incoming-response",
        "wasi:http/types@0.2.9.[resource-drop]outgoing-body",
        "wasi:http/types@0.2.9.[resource-drop]outgoing-request",
        "wasi:http/types@0.2.9.[resource-drop]outgoing-response",
        "wasi:http/types@0.2.9.[resource-drop]request-options",
        "wasi:http/types@0.2.9.[resource-drop]response-outparam",
        "wasi:http/types@0.2.9.[static]incoming-body.finish",
        "wasi:http/types@0.2.9.[static]outgoing-body.finish",
        "wasi:http/types@0.2.9.[static]response-outparam.set",
    ]
    
    // MARK: - HttpOutgoingHandlerProvider
    static let httpOutgoingHandler: Set<String> = [
        "wasi:http/outgoing-handler@0.2.9.handle",
    ]
    
    // MARK: - ClocksProvider
    static let clocks: Set<String> = [
        "wasi:clocks/monotonic-clock@0.2.4.now",
        "wasi:clocks/monotonic-clock@0.2.4.subscribe-duration",
        "wasi:clocks/monotonic-clock@0.2.9.subscribe-duration",
        "wasi:clocks/wall-clock@0.2.9.now",
    ]
    
    // MARK: - RandomProvider
    static let random: Set<String> = [
        "wasi:random/insecure-seed@0.2.4.insecure-seed",
        "wasi:random/random@0.2.9.get-random-bytes",
        "wasi:random/random@0.2.9.get-random-u64",
    ]
    
    // MARK: - CliProvider
    static let cli: Set<String> = [
        "wasi:cli/stderr@0.2.4.get-stderr",
        "wasi:cli/stdout@0.2.4.get-stdout",
        "wasi:cli/stdin@0.2.4.get-stdin",
        "wasi:cli/terminal-output@0.2.9.[resource-drop]terminal-output",
        "wasi:cli/terminal-stdout@0.2.9.get-terminal-stdout",
    ]
    
    // MARK: - SocketsProvider
    static let sockets: Set<String> = [
        "wasi:sockets/tcp@0.2.0.[resource-drop]tcp-socket",
        "wasi:sockets/udp@0.2.0.[resource-drop]incoming-datagram-stream",
        "wasi:sockets/udp@0.2.0.[resource-drop]outgoing-datagram-stream",
        "wasi:sockets/udp@0.2.0.[resource-drop]udp-socket",
    ]
    
    // MARK: - ModuleLoaderProvider (MCP-specific)
    static let moduleLoader: Set<String> = [
        "mcp:module-loader/loader@0.1.0.get-lazy-module",
        "mcp:module-loader/loader@0.1.0.is-interactive-command",
        "mcp:module-loader/loader@0.1.0.has-jspi",
        "mcp:module-loader/loader@0.1.0.spawn-lazy-command",
        "mcp:module-loader/loader@0.1.0.spawn-interactive",
        "mcp:module-loader/loader@0.1.0.spawn-worker-command",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.set-raw-mode",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.write-stdin",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.close-stdin",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.read-stdout",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.read-stderr",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.try-wait",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.is-ready",
        "mcp:module-loader/loader@0.1.0.[method]lazy-process.get-ready-pollable",
        "mcp:module-loader/loader@0.1.0.[resource-drop]lazy-process",
    ]
    
    // MARK: - SharedWASIImports (wasi_snapshot_preview1)
    static let preview1: Set<String> = [
        "wasi_snapshot_preview1.adapter_close_badfd",
        "wasi_snapshot_preview1.clock_time_get",
        "wasi_snapshot_preview1.environ_get",
        "wasi_snapshot_preview1.environ_sizes_get",
        "wasi_snapshot_preview1.fd_close",
        "wasi_snapshot_preview1.fd_fdstat_get",
        "wasi_snapshot_preview1.fd_filestat_get",
        "wasi_snapshot_preview1.fd_filestat_set_size",
        "wasi_snapshot_preview1.fd_prestat_dir_name",
        "wasi_snapshot_preview1.fd_prestat_get",
        "wasi_snapshot_preview1.fd_read",
        "wasi_snapshot_preview1.fd_readdir",
        "wasi_snapshot_preview1.fd_seek",
        "wasi_snapshot_preview1.fd_tell",
        "wasi_snapshot_preview1.fd_write",
        "wasi_snapshot_preview1.path_create_directory",
        "wasi_snapshot_preview1.path_filestat_get",
        "wasi_snapshot_preview1.path_link",
        "wasi_snapshot_preview1.path_open",
        "wasi_snapshot_preview1.path_readlink",
        "wasi_snapshot_preview1.path_remove_directory",
        "wasi_snapshot_preview1.path_rename",
        "wasi_snapshot_preview1.path_unlink_file",
        "wasi_snapshot_preview1.proc_exit",
    ]
    
    // MARK: - All Declared Imports
    
    /// Combined set of all imports declared by all providers
    static var allDeclared: Set<String> {
        ioPoll
            .union(ioStreams)
            .union(ioError)
            .union(httpTypes)
            .union(httpOutgoingHandler)
            .union(clocks)
            .union(random)
            .union(cli)
            .union(sockets)
            .union(moduleLoader)
            .union(preview1)
    }
    
    // MARK: - Validation
    
    /// Returns imports required by Agent WASM but not declared by any provider
    static var missingForAgent: Set<String> {
        WebHeadlessAgentSyncWebHeadlessAgentIosCoreWASMImports.required.subtracting(allDeclared)
    }
    
    /// Returns imports required by MCP WASM but not declared by any provider
    static var missingForMCP: Set<String> {
        McpServerSyncTsRuntimeMcpCoreWASMImports.required.subtracting(allDeclared)
    }
    
    /// Returns imports required by TSX Engine WASM but not declared by any provider
    static var missingForTSX: Set<String> {
        TsxEngineSyncTsxEngineCoreWASMImports.required.subtracting(allDeclared)
    }
    
    /// Returns all imports required by any WASM module but not declared by any provider
    static var missingForAll: Set<String> {
        AllWASMImports.allRequired.subtracting(allDeclared)
    }
}
