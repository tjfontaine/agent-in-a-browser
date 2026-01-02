/**
 * WASM Async Mode Detection and Dynamic Loading
 * 
 * Detects whether the browser supports JSPI (JavaScript Promise Integration)
 * and loads the appropriate transpiled WASM modules accordingly.
 * 
 * - Chrome with flags: Uses JSPI mode (true lazy loading with async suspension)
 * - Safari/Firefox: Uses Sync mode (eager loading, no async suspension)
 */

// JSPI feature detection - Suspending is not yet in TypeScript's lib.dom.d.ts
// Using a type-safe check that avoids 'any'
const webAssembly = WebAssembly as typeof WebAssembly & { Suspending?: unknown };

/**
 * Check if the browser supports JSPI (JavaScript Promise Integration)
 */
export const hasJSPI = typeof webAssembly.Suspending !== 'undefined';

// Log the detected mode at startup
console.log(`[AsyncMode] JSPI support: ${hasJSPI ? 'YES' : 'NO'}`);

// Type for the incomingHandler interface
interface IncomingHandler {
    handle: (request: unknown, responseOutparam: unknown) => void | Promise<void>;
}

// Type for MCP server module
interface McpServerModule {
    incomingHandler: IncomingHandler;
    $init?: Promise<void>;
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
            const module = await import('../mcp-server-jspi/ts-runtime-mcp.js');
            cachedIncomingHandler = module.incomingHandler as IncomingHandler;
        } else {
            console.log('[AsyncMode] Loading Sync-mode MCP server...');
            // Dynamic import for sync module - use runtime path to prevent Vite from pre-resolving
            // This module may not exist in CI builds (only JSPI mode is transpiled)
            const syncPath = '../mcp-server-sync/ts-runtime-mcp.js';
            try {
                const module: McpServerModule = await import(/* @vite-ignore */ syncPath);
                // With --tla-compat, we must await $init before accessing exports
                if (module.$init) {
                    await module.$init;
                }
                cachedIncomingHandler = module.incomingHandler as IncomingHandler;
            } catch (err) {
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

