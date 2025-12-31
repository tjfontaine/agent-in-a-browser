/**
 * @tjfontaine/browser-mcp-runtime
 * 
 * Meta-package that re-exports all @tjfontaine WASI/MCP packages
 * and provides a convenience function for creating an MCP server
 * with default browser-compatible implementations.
 */

// Re-export opfs-wasi-fs
export * from '@tjfontaine/opfs-wasi-fs';

// Re-export wasi-http-handler
export * from '@tjfontaine/wasi-http-handler';

// Re-export wasi-shims
export * from '@tjfontaine/wasi-shims';

// Re-export mcp-wasm-server
export * from '@tjfontaine/mcp-wasm-server';

// Convenience factory function
import { initFilesystem } from '@tjfontaine/opfs-wasi-fs';
import { loadMcpServer, initializeForSyncMode, hasJSPI } from '@tjfontaine/mcp-wasm-server';

/**
 * Initialize the complete MCP runtime with default browser implementations.
 * 
 * This function:
 * 1. Initializes the OPFS filesystem
 * 2. Loads the MCP server (JSPI or sync mode based on browser support)
 * 3. Pre-loads lazy modules in sync mode (Safari/Firefox)
 * 
 * @returns Promise that resolves when runtime is ready
 */
export async function initializeMcpRuntime(): Promise<void> {
    // Initialize OPFS filesystem
    await initFilesystem();

    // Load MCP server (auto-detects JSPI/sync mode)
    await loadMcpServer();

    // In sync mode, eagerly load all lazy modules
    await initializeForSyncMode();
}

/**
 * Check if the browser supports JSPI (JavaScript Promise Integration)
 */
export function supportsJSPI(): boolean {
    return hasJSPI;
}
