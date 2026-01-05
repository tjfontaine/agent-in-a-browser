/**
 * Sandbox Worker Management
 * 
 * Manages the sandbox worker for MCP tool execution via workerFetch.
 */

import { createWorkerFetch } from '../workers/Fetch';
import { createWorkerFetchSimple } from '../workers/FetchSimple';

// ============ Worker Instance ============

// Create a unique identifier for this module instance
const moduleId = Math.random().toString(36).substring(7);
console.log(`[Sandbox] Module loaded, moduleId: ${moduleId}`);

const sandbox = new Worker(new URL('../workers/SandboxWorker.ts', import.meta.url), { type: 'module' });
console.log(`[Sandbox] Worker created in moduleId: ${moduleId}`);

// Export the raw Worker for debugging
export { sandbox as sandboxWorker };

// ============ Worker Fetch ============

/**
 * Fetch-like function to communicate with the sandbox worker (uses MessageChannel)
 * Note: MessageChannel port transfer fails silently in Safari workers
 */
export const fetchFromSandbox = createWorkerFetch(sandbox);

/**
 * Safari-compatible fetch using request IDs and plain postMessage
 * Use this in sync mode (Safari/WebKit) where MessageChannel ports don't work
 */
export const fetchFromSandboxSimple = createWorkerFetchSimple(sandbox);

/**
 * Debug function to test if postMessage works directly
 */
export function debugPostToSandbox(message: unknown): void {
    console.log('[Sandbox] Debug postMessage:', message);
    sandbox.postMessage(message);
}


// ============ Initialization ============

// Flag to track if worker is ready - set up IMMEDIATELY so we don't miss the ready signal
let workerReadyResolve: () => void;
let isWorkerReady = false;
new Promise<void>((resolve) => {
    workerReadyResolve = resolve;
});

// Listen for ready signal immediately (before initializeSandbox is called)
sandbox.addEventListener('message', function onReady(event: MessageEvent) {
    if (event.data?.type === 'ready') {
        console.log('[Sandbox] Worker ready signal received');
        isWorkerReady = true;
        workerReadyResolve();
        sandbox.removeEventListener('message', onReady);
    }
});

/**
 * Initialize the sandbox worker.
 * Waits for worker to have signaled ready, then sends init message.
 */
export function initializeSandbox(): Promise<void> {
    console.log('[Sandbox] initializeSandbox() called');
    return new Promise((resolve, reject) => {
        const handler = (event: MessageEvent) => {
            console.log('[Sandbox] Received message from worker:', event.data);
            const { type } = event.data;

            // Also handle ready here as fallback
            if (type === 'ready') {
                console.log('[Sandbox] Worker ready (fallback handler), sending init message');
                isWorkerReady = true;
                workerReadyResolve();
                sandbox.postMessage({ type: 'init', id: 'init-' + Date.now() });
            } else if (type === 'init_complete') {
                console.log('[Sandbox] Worker init complete!');
                sandbox.removeEventListener('message', handler);
                resolve();
            } else if (type === 'error') {
                console.error('[Sandbox] Worker error during init:', event.data);
                sandbox.removeEventListener('message', handler);
                reject(new Error(event.data.message || 'Worker error'));
            }
        };
        sandbox.addEventListener('message', handler);

        // If worker is already ready, send init immediately
        if (isWorkerReady) {
            console.log('[Sandbox] Worker already ready, sending init message');
            sandbox.postMessage({ type: 'init', id: 'init-' + Date.now() });
        } else {
            // Request a ping in case we missed the ready signal
            console.log('[Sandbox] Waiting for worker ready signal...');
            sandbox.postMessage({ type: 'ping' });
        }
    });
}

/**
 * Legacy callbacks - retained as no-ops or for partial compatibility if needed,
 * but mostly deprecated as the worker no longer emits these events via postMessage.
 */
export function setSandboxCallbacks(_callbacks: unknown): void {
    // No-op
}



