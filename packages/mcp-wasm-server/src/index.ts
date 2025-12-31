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

// Export lazy module loading
export {
    isLazyCommand,
    getModuleForCommand,
    loadLazyModule,
    loadModuleForCommand,
    getLazyCommandList,
    isModuleLoaded,
    getLoadedModuleSync,
    preloadModule,
    initializeForSyncMode,
    LAZY_COMMANDS,
    type CommandModule,
    type CommandHandle,
    type InputStream,
    type OutputStream,
    type ExecEnv,
} from './lazy-modules';

// Export module loader impl
export {
    getLazyModule,
    spawnLazyCommand,
    spawnInteractive,
    LazyProcess,
} from './module-loader-impl';
