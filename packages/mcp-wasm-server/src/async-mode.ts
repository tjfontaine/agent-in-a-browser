/// <reference path="./declarations.d.ts" />
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
// JSPI Check
export const hasJSPI = typeof webAssembly.Suspending !== 'undefined';

// Worker Mode Check (for Safari)
// Use a safe check for WorkerGlobalScope
const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
export const isWorkerMode = !hasJSPI && isWorker;

// Import sync bridge initializers (lazy loaded)
// These are only needed in worker mode (Safari)
import * as wasiShims from '@tjfontaine/wasi-shims';

// Log the detected mode at startup
console.log(`[AsyncMode] JSPI support: ${hasJSPI ? 'YES' : 'NO'}`);

// Type for the incomingHandler interface
interface IncomingHandler {
    handle: (request: unknown, responseOutparam: unknown) => void | Promise<void>;
}

// Import types from generated modules (for $init Promise)
type McpServerModule = typeof import('../mcp-server-sync/ts-runtime-mcp.js');

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
            console.log(`[AsyncMode] Loading Sync-mode MCP server... (Worker: ${isWorkerMode})`);

            // In worker mode, we must initialize the sync bridges first
            if (isWorkerMode) {
                // Get the shared buffer from the worker init message (stored globally or passed in)
                // For now, we assume global access or handled by a separate init function
                // Ideally this should be part of the module loading, but the worker bridge handles it

                // Note: The wasm-worker.ts script initializes the global state directly
                // This loader is just for the WASM module itself
            }

            const module: McpServerModule = await import('../mcp-server-sync/ts-runtime-mcp.js');
            // With --tla-compat, we must await $init before accessing exports
            if (module.$init) {
                await module.$init;
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

