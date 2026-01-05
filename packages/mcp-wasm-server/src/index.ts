/**
 * @tjfontaine/mcp-wasm-server
 * 
 * MCP WASM server with prebuilt WASM binaries.
 * Accepts injected filesystem and HTTP handler dependencies.
 * 
 * This package provides the core MCP server functionality
 * with composable dependencies.
 */

// Export the WASM bridge
export { callWasmMcpServerFetch } from './WasmBridge';

// Export async mode utilities
export { hasJSPI, loadMcpServer, getIncomingHandler, isMcpServerLoaded } from './async-mode';

// Note: lazy-modules and module-loader-impl are intentionally NOT exported from this package.
// The frontend uses its own local versions of these files with correct import paths.
// See: frontend/src/wasm/lazy-loading/lazy-modules.ts
