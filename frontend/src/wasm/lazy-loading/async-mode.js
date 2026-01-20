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
// Re-export from the canonical source of truth
export { hasJSPI, getExecutionMode, setExecutionMode, isSyncMode, isSyncWorkerMode, canSuspendAsync, } from '@tjfontaine/wasi-shims/execution-mode.js';
import { hasJSPI, isSyncWorkerMode } from '@tjfontaine/wasi-shims/execution-mode.js';
// Log the detected mode at startup (for backward compatibility)
console.log(`[AsyncMode] JSPI support: ${hasJSPI ? 'YES' : 'NO'}`);
// Cached module references
let cachedIncomingHandler = null;
let loadingPromise = null;
/**
 * Load the MCP server module based on detected async mode.
 * This is called once during initialization.
 */
export async function loadMcpServer() {
    if (cachedIncomingHandler) {
        return cachedIncomingHandler;
    }
    if (loadingPromise) {
        return loadingPromise;
    }
    loadingPromise = (async () => {
        if (hasJSPI) {
            console.log('[AsyncMode] Loading JSPI-mode MCP server...');
            const module = await import('@tjfontaine/mcp-wasm-server/mcp-server-jspi/ts-runtime-mcp.js');
            cachedIncomingHandler = module.incomingHandler;
        }
        else {
            console.log(`[AsyncMode] Loading Sync-mode MCP server... (Worker: ${isSyncWorkerMode()})`);
            // Dynamic import for sync module - use package path for proper resolution
            try {
                // Type assertion needed because transpiled module has concrete types but we use unknown in our interface
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const module = await import('@tjfontaine/mcp-wasm-server/mcp-server-sync/ts-runtime-mcp.js');
                // With --tla-compat, we must await $init before accessing exports
                if (module.$init) {
                    await module.$init;
                }
                cachedIncomingHandler = module.incomingHandler;
            }
            catch (err) {
                throw new Error(`Sync mode MCP server not available. JSPI is required. Error: ${err}`);
            }
        }
        return cachedIncomingHandler;
    })();
    return loadingPromise;
}
/**
 * Get the cached incoming handler. Throws if not yet loaded.
 */
export function getIncomingHandler() {
    if (!cachedIncomingHandler) {
        throw new Error('MCP server not yet loaded. Call loadMcpServer() first.');
    }
    return cachedIncomingHandler;
}
/**
 * Check if the MCP server module is loaded.
 */
export function isMcpServerLoaded() {
    return cachedIncomingHandler !== null;
}
