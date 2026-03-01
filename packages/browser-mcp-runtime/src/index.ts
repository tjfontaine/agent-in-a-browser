/**
 * @tjfontaine/browser-mcp-runtime
 *
 * Meta-package that re-exports all @tjfontaine WASI/MCP packages
 * and provides a convenience function for creating an MCP server
 * with default browser-compatible implementations.
 */

// Re-export WASI filesystem type interfaces
export type {
    WasiFilesystem,
    WasiDatetime,
    WasiStat,
    DirectoryEntry,
    OpenFlags,
    IDescriptor,
    IDirectoryEntryStream,
    IPreopens,
    IFilesystemTypes,
} from '@tjfontaine/wasi-shims/wasi-filesystem-types.js';

// Re-export wasi-shims (includes OPFS filesystem impl, streams, clocks, HTTP, etc.)
export * from '@tjfontaine/wasi-shims';

// Re-export mcp-wasm-server
export * from '@tjfontaine/mcp-wasm-server';

// Convenience factory function
import { initFilesystem } from '@tjfontaine/wasi-shims/opfs-filesystem-impl.js';
import { loadMcpServer, hasJSPI } from '@tjfontaine/mcp-wasm-server';

/**
 * Initialize the complete MCP runtime with default browser implementations.
 *
 * This function:
 * 1. Initializes the OPFS filesystem
 * 2. Loads the MCP server (JSPI or sync mode based on browser support)
 *
 * @returns Promise that resolves when runtime is ready
 */
export async function initializeMcpRuntime(): Promise<void> {
    await initFilesystem();
    await loadMcpServer();
}

/**
 * Check if the browser supports JSPI (JavaScript Promise Integration)
 */
export function supportsJSPI(): boolean {
    return hasJSPI;
}
