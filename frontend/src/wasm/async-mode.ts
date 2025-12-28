/**
 * WASM Async Mode Detection and Dynamic Loading
 * 
 * Detects whether the browser supports JSPI (JavaScript Promise Integration)
 * and loads the appropriate transpiled WASM modules accordingly.
 * 
 * - Chrome with flags: Uses JSPI mode (true lazy loading with async suspension)
 * - Safari/Firefox: Uses Sync mode (eager loading, no async suspension)
 */

/**
 * Check if the browser supports JSPI (JavaScript Promise Integration)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hasJSPI = typeof (WebAssembly as any)?.Suspending !== 'undefined';

// Log the detected mode at startup
console.log(`[AsyncMode] JSPI support: ${hasJSPI ? 'YES' : 'NO'}`);

// Type for the incomingHandler interface
interface IncomingHandler {
    handle: (request: unknown, responseOutparam: unknown) => void | Promise<void>;
}

// Cached module references
let cachedIncomingHandler: IncomingHandler | null = null;
let loadingPromise: Promise<IncomingHandler> | null = null;

/**
 * Load the MCP server module based on detected async mode.
 * This is called once during initialization.
 */
export async function loadMcpServer(): Promise<IncomingHandler> {
    if (cachedIncomingHandler) {
        return cachedIncomingHandler;
    }

    if (loadingPromise) {
        return loadingPromise;
    }

    loadingPromise = (async () => {
        if (hasJSPI) {
            console.log('[AsyncMode] Loading JSPI-mode MCP server...');
            const module = await import('./mcp-server-jspi/ts-runtime-mcp.js');
            cachedIncomingHandler = module.incomingHandler as IncomingHandler;
        } else {
            console.log('[AsyncMode] Loading Sync-mode MCP server...');
            const module = await import('./mcp-server-sync/ts-runtime-mcp.js');
            // With --tla-compat, we must await $init before accessing exports
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const $init = (module as any).$init;
            if ($init) {
                await $init;
            }
            cachedIncomingHandler = module.incomingHandler as IncomingHandler;
        }
        return cachedIncomingHandler;
    })();

    return loadingPromise;
}

/**
 * Get the cached incoming handler. Throws if not yet loaded.
 */
export function getIncomingHandler(): IncomingHandler {
    if (!cachedIncomingHandler) {
        throw new Error('MCP server not yet loaded. Call loadMcpServer() first.');
    }
    return cachedIncomingHandler;
}

/**
 * Check if the MCP server module is loaded.
 */
export function isMcpServerLoaded(): boolean {
    return cachedIncomingHandler !== null;
}
