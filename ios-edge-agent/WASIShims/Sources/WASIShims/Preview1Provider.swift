/// Preview1Provider.swift
/// Type-safe WASI import provider for wasi_snapshot_preview1

import WasmKit
import WASIP2Harness
import OSLog

/// Provides type-safe WASI imports for preview1 interface.
/// This wraps SharedWASIImports.registerPreview1 to integrate with the provider validation system.
public struct Preview1Provider: WASIProvider {
    public static var moduleName: String { "wasi_snapshot_preview1" }
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        [
            // Core environment
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "environ_get", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "environ_sizes_get", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "proc_exit", parameters: [.i32], results: []),
            // File descriptors
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_close", parameters: [.i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_read", parameters: [.i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_write", parameters: [.i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_seek", parameters: [.i32, .i64, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_tell", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_filestat_get", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_filestat_set_size", parameters: [.i32, .i64], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_readdir", parameters: [.i32, .i32, .i32, .i64, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_prestat_get", parameters: [.i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_prestat_dir_name", parameters: [.i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "fd_fdstat_get", parameters: [.i32, .i32], results: [.i32]),
            // Clock
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "clock_time_get", parameters: [.i32, .i64, .i32], results: [.i32]),
            // Path operations
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_open", parameters: [.i32, .i32, .i32, .i32, .i32, .i64, .i64, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_create_directory", parameters: [.i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_remove_directory", parameters: [.i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_unlink_file", parameters: [.i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_rename", parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_filestat_get", parameters: [.i32, .i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_link", parameters: [.i32, .i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]),
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "path_readlink", parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: [.i32]),
            // Adapter
            WASIImportDeclaration(module: "wasi_snapshot_preview1", name: "adapter_close_badfd", parameters: [.i32], results: [.i32]),
        ]
    }
    
    private let resources: ResourceRegistry
    private let filesystem: SandboxFilesystem?
    
    public init(resources: ResourceRegistry, filesystem: SandboxFilesystem? = nil) {
        self.resources = resources
        self.filesystem = filesystem
    }
    
    public func register(into imports: inout Imports, store: Store) {
        // Delegate to SharedWASIImports for the actual implementation
        SharedWASIImports.registerPreview1(&imports, store: store, resources: resources, filesystem: filesystem)
    }
}
