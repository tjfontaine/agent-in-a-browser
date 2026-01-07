/**
 * WASM Async Mode Detection and Dynamic Loading
 *
 * Detects whether the browser supports JSPI (JavaScript Promise Integration)
 * and loads the appropriate transpiled WASM modules accordingly.
 *
 * - Chrome with flags: Uses JSPI mode (true lazy loading with async suspension)
 * - Safari/Firefox: Uses Sync mode (eager loading, no async suspension)
 *
 * NOTE: hasJSPI and execution mode detection are now centralized in
 * @tjfontaine/wasi-shims/execution-mode.js. This module re-exports those
 * for backward compatibility while adding frontend-specific MCP loading logic.
 */
export { hasJSPI, getExecutionMode, setExecutionMode, isSyncMode, isSyncWorkerMode, canSuspendAsync, type ExecutionMode, } from '@tjfontaine/wasi-shims/execution-mode.js';
interface IncomingHandler {
    handle: (request: unknown, responseOutparam: unknown) => void | Promise<void>;
}
/**
 * Load the MCP server module based on detected async mode.
 * This is called once during initialization.
 */
export declare function loadMcpServer(): Promise<IncomingHandler>;
/**
 * Get the cached incoming handler. Throws if not yet loaded.
 */
export declare function getIncomingHandler(): IncomingHandler;
/**
 * Check if the MCP server module is loaded.
 */
export declare function isMcpServerLoaded(): boolean;
//# sourceMappingURL=async-mode.d.ts.map