/**
 * Sandbox Worker Management
 * 
 * Uses SharedWorker to ensure all code shares the same module context.
 * This fixes the Pollable instanceof issue where different bundles have different class instances.
 */

import { createWorkerFetch } from '../workers/Fetch';
import { createWorkerFetchSimple } from '../workers/FetchSimple';

// ============ SharedWorker Instance ============

const moduleId = Math.random().toString(36).substring(7);
console.log(`[Sandbox] Module loaded, moduleId: ${moduleId}`);

// Try SharedWorker first, fall back to regular Worker if not supported
let sandboxPort: MessagePort;
let isSharedWorker = false;

try {
    const sharedWorker = new SharedWorker(
        new URL('../workers/SharedSandboxWorker.ts', import.meta.url),
        { type: 'module', name: 'sandbox' }
    );
    sandboxPort = sharedWorker.port;
    sandboxPort.start();
    isSharedWorker = true;
    console.log(`[Sandbox] SharedWorker created in moduleId: ${moduleId}`);
} catch (e) {
    console.warn('[Sandbox] SharedWorker not supported, falling back to Worker:', e);
    const worker = new Worker(
        new URL('../workers/SandboxWorker.ts', import.meta.url),
        { type: 'module' }
    );
    // Create a MessagePort-like wrapper around Worker
    sandboxPort = {
        postMessage: (msg: unknown, transfer?: Transferable[]) => worker.postMessage(msg, transfer || []),
        addEventListener: (type: string, listener: EventListener) => worker.addEventListener(type, listener),
        removeEventListener: (type: string, listener: EventListener) => worker.removeEventListener(type, listener),
        start: () => { },
        close: () => worker.terminate(),
        onmessage: null,
        onmessageerror: null,
        dispatchEvent: (event: Event) => worker.dispatchEvent(event),
    } as MessagePort;
    console.log(`[Sandbox] Worker fallback created in moduleId: ${moduleId}`);
}

// Export the port for debugging
export { sandboxPort, isSharedWorker };

// ============ Worker Fetch ============

// Wrapper that adapts MessagePort to Worker-like interface for existing utilities
const workerLikeInterface = {
    postMessage: (msg: unknown, transfer?: Transferable[]) => sandboxPort.postMessage(msg, transfer ? { transfer } : undefined),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        sandboxPort.addEventListener(type, listener as EventListener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        sandboxPort.removeEventListener(type, listener as EventListener),
};

/**
 * Fetch-like function to communicate with the sandbox worker (uses MessageChannel)
 * Note: MessageChannel port transfer fails silently in Safari workers
 */
export const fetchFromSandbox = createWorkerFetch(workerLikeInterface as Worker);

/**
 * Safari-compatible fetch using request IDs and plain postMessage
 * Use this in sync mode (Safari/WebKit) where MessageChannel ports don't work
 */
export const fetchFromSandboxSimple = createWorkerFetchSimple(workerLikeInterface as Worker);

/**
 * Debug function to test if postMessage works directly
 */
export function debugPostToSandbox(message: unknown): void {
    console.log('[Sandbox] Debug postMessage:', message);
    sandboxPort.postMessage(message);
}

// Legacy export for backwards compatibility
export const sandboxWorker = workerLikeInterface as unknown as Worker;


// ============ Initialization ============

let workerReadyResolve: () => void;
let isWorkerReady = false;
new Promise<void>((resolve) => {
    workerReadyResolve = resolve;
});

// Listen for ready signal immediately
sandboxPort.addEventListener('message', function onReady(event: MessageEvent) {
    if (event.data?.type === 'ready') {
        console.log('[Sandbox] Worker ready signal received');
        isWorkerReady = true;
        workerReadyResolve();
        sandboxPort.removeEventListener('message', onReady);
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
                sandboxPort.postMessage({ type: 'init', id: 'init-' + Date.now() });
            } else if (type === 'init_complete') {
                console.log('[Sandbox] Worker init complete!');
                sandboxPort.removeEventListener('message', handler);
                resolve();
            } else if (type === 'error') {
                console.error('[Sandbox] Worker error during init:', event.data);
                sandboxPort.removeEventListener('message', handler);
                reject(new Error(event.data.message || 'Worker error'));
            }
        };
        sandboxPort.addEventListener('message', handler);

        // If worker is already ready, send init immediately
        if (isWorkerReady) {
            console.log('[Sandbox] Worker already ready, sending init message');
            sandboxPort.postMessage({ type: 'init', id: 'init-' + Date.now() });
        } else {
            // Request a ping in case we missed the ready signal
            console.log('[Sandbox] Waiting for worker ready signal...');
            sandboxPort.postMessage({ type: 'ping' });
        }
    });
}

/**
 * Legacy callbacks - retained as no-ops for compatibility
 */
export function setSandboxCallbacks(_callbacks: unknown): void {
    // No-op
}
