/**
 * Sandbox Worker Management
 * 
 * Uses SharedWorker to ensure all code shares the same module context.
 * Falls back to regular Worker if SharedWorker is not supported or fails
 * (e.g., OPFS not available in SharedWorker context in some browsers).
 */

import { createWorkerFetch } from '../workers/Fetch';
import { createWorkerFetchSimple } from '../workers/FetchSimple';

// ============ Worker Instance Management ============

const moduleId = Math.random().toString(36).substring(7);
console.log(`[Sandbox] Module loaded, moduleId: ${moduleId}`);

// Worker state
let sandboxPort: MessagePort;
let isSharedWorker = false;
let workerInstance: SharedWorker | Worker | null = null;

// Initialization state
let isWorkerReady = false;
let isInitialized = false;
let workerReadyResolve: () => void;
let workerReadyPromise = new Promise<void>((resolve) => {
    workerReadyResolve = resolve;
});

// ============ Worker Creation ============

function createMessagePortInterface(worker: Worker): MessagePort {
    // Create a MessagePort-like wrapper around Worker
    return {
        postMessage: (msg: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
            if (Array.isArray(transfer)) {
                worker.postMessage(msg, transfer);
            } else if (transfer && typeof transfer === 'object' && 'transfer' in transfer) {
                worker.postMessage(msg, transfer.transfer as Transferable[]);
            } else {
                worker.postMessage(msg);
            }
        },
        addEventListener: (type: string, listener: EventListener) => worker.addEventListener(type, listener),
        removeEventListener: (type: string, listener: EventListener) => worker.removeEventListener(type, listener),
        start: () => { /* no-op for Worker */ },
        close: () => worker.terminate(),
        onmessage: null,
        onmessageerror: null,
        dispatchEvent: (event: Event) => worker.dispatchEvent(event),
    } as MessagePort;
}

function createSharedWorker(): { port: MessagePort; worker: SharedWorker } | null {
    try {
        const sharedWorker = new SharedWorker(
            new URL('../workers/SharedSandboxWorker.ts', import.meta.url),
            { type: 'module', name: 'sandbox' }
        );
        sharedWorker.port.start();
        console.log(`[Sandbox] SharedWorker created in moduleId: ${moduleId}`);
        return { port: sharedWorker.port, worker: sharedWorker };
    } catch (e) {
        console.warn('[Sandbox] SharedWorker not supported:', e);
        return null;
    }
}

function createDedicatedWorker(): { port: MessagePort; worker: Worker } {
    const worker = new Worker(
        new URL('../workers/SandboxWorker.ts', import.meta.url),
        { type: 'module' }
    );
    console.log(`[Sandbox] Worker fallback created in moduleId: ${moduleId}`);
    return { port: createMessagePortInterface(worker), worker };
}

// ============ Worker Ready Handler ============

function setupReadyHandler(port: MessagePort): void {
    const onReady = (event: MessageEvent) => {
        if (event.data?.type === 'ready') {
            console.log('[Sandbox] Worker ready signal received');
            isWorkerReady = true;
            workerReadyResolve();
            port.removeEventListener('message', onReady);
        }
    };
    port.addEventListener('message', onReady);

    // Global handler for worker debug logs (stays active throughout)
    port.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'worker-log') {
            console.log('[WorkerLog]', event.data.msg, event.data.data || '', `(t=${event.data.time})`);
        }
    });
}

// ============ Worker Initialization ============

async function initializeWorker(port: MessagePort): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            port.removeEventListener('message', handler);
            reject(new Error('Worker initialization timeout'));
        }, 30000);

        const handler = (event: MessageEvent) => {
            const { type, message } = event.data;

            if (type === 'ready') {
                console.log('[Sandbox] Worker ready (in init handler), sending init message');
                isWorkerReady = true;
                workerReadyResolve();
                port.postMessage({ type: 'init', id: 'init-' + Date.now() });
            } else if (type === 'init_complete') {
                console.log('[Sandbox] Worker init complete!');
                clearTimeout(timeoutId);
                port.removeEventListener('message', handler);
                resolve();
            } else if (type === 'error') {
                console.error('[Sandbox] Worker error during init:', message);
                clearTimeout(timeoutId);
                port.removeEventListener('message', handler);
                reject(new Error(message || 'Worker initialization error'));
            }
        };

        port.addEventListener('message', handler);

        // If worker is already ready, send init immediately
        if (isWorkerReady) {
            console.log('[Sandbox] Worker already ready, sending init message');
            port.postMessage({ type: 'init', id: 'init-' + Date.now() });
        } else {
            // Request a ping in case we missed the ready signal
            console.log('[Sandbox] Waiting for worker ready signal...');
            port.postMessage({ type: 'ping' });
        }
    });
}

// ============ Initial Worker Setup ============

// Try SharedWorker first
const sharedWorkerResult = createSharedWorker();
if (sharedWorkerResult) {
    sandboxPort = sharedWorkerResult.port;
    workerInstance = sharedWorkerResult.worker;
    isSharedWorker = true;
} else {
    // Fall back to dedicated worker immediately if SharedWorker not supported
    const dedicatedWorkerResult = createDedicatedWorker();
    sandboxPort = dedicatedWorkerResult.port;
    workerInstance = dedicatedWorkerResult.worker;
    isSharedWorker = false;
}

// Set up ready handler for current worker
setupReadyHandler(sandboxPort);

// Export the port for debugging
export { sandboxPort, isSharedWorker };

// ============ Debug Mode ============

// Check for ?debug=true query string to enable WASM stderr forwarding
const debugMode = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('debug') === 'true';

if (debugMode) {
    console.log('[Sandbox] Debug mode enabled - WASM stderr will be forwarded to console');
}

// Listen for debug stderr messages from worker
sandboxPort.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'debug_stderr') {
        console.log('[WASM stderr]', event.data.text);
    } else if (event.data?.type === 'debug_mode_set') {
        console.log('[Sandbox] Debug mode set confirmed:', event.data.enabled);
    }
});

// ============ Worker Fetch ============

// Wrapper that adapts MessagePort to Worker-like interface for existing utilities
// Track listeners to support re-attaching on worker fallback
const activeListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

const workerLikeInterface = {
    postMessage: (msg: unknown, transfer?: Transferable[]) => sandboxPort.postMessage(msg, transfer ? { transfer } : undefined),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (!activeListeners.has(type)) {
            activeListeners.set(type, new Set());
        }
        activeListeners.get(type)?.add(listener);
        sandboxPort.addEventListener(type, listener as EventListener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        activeListeners.get(type)?.delete(listener);
        sandboxPort.removeEventListener(type, listener as EventListener);
    },
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

// ============ Public Initialization ============

/**
 * Initialize the sandbox worker.
 * If SharedWorker init fails (e.g., OPFS not available), automatically
 * falls back to dedicated Worker and retries initialization.
 */
export async function initializeSandbox(): Promise<void> {
    console.log('[Sandbox] initializeSandbox() called, isSharedWorker:', isSharedWorker);

    if (isInitialized) {
        console.log('[Sandbox] Already initialized');
        return;
    }

    try {
        await initializeWorker(sandboxPort);
        isInitialized = true;

        // Enable debug mode if requested via query string
        if (debugMode) {
            sandboxPort.postMessage({ type: 'set_debug_mode', id: 'debug-' + Date.now(), enabled: true });
        }

        console.log('[Sandbox] Initialization complete with', isSharedWorker ? 'SharedWorker' : 'Worker');
    } catch (error) {
        // If SharedWorker init failed, try falling back to dedicated Worker
        if (isSharedWorker) {
            console.warn('[Sandbox] SharedWorker init failed, falling back to dedicated Worker:', error);

            // Terminate the failed SharedWorker
            if (workerInstance && 'port' in workerInstance) {
                try {
                    (workerInstance as SharedWorker).port.close();
                } catch (e) {
                    console.warn('[Sandbox] Failed to close SharedWorker port:', e);
                }
            }

            // Reset state for new worker
            isWorkerReady = false;
            isSharedWorker = false;
            workerReadyPromise = new Promise<void>((resolve) => {
                workerReadyResolve = resolve;
            });

            // Create dedicated worker
            const dedicatedWorkerResult = createDedicatedWorker();
            sandboxPort = dedicatedWorkerResult.port;
            workerInstance = dedicatedWorkerResult.worker;

            // Update the workerLikeInterface to use new port
            // (Methods already reference 'sandboxPort' variable which is updated above)
            // But we MUST re-attach all listeners that were registered on the old port
            console.log('[Sandbox] Re-attaching listeners to fallback worker port...');
            activeListeners.forEach((listeners, type) => {
                listeners.forEach(listener => {
                    sandboxPort.addEventListener(type, listener as EventListener);
                });
            });

            // Set up ready handler for new worker
            setupReadyHandler(sandboxPort);

            // Set up debug listener on new port
            sandboxPort.addEventListener('message', (event: MessageEvent) => {
                if (event.data?.type === 'debug_stderr') {
                    console.log('[WASM stderr]', event.data.text);
                }
            });

            // Retry initialization with dedicated worker
            console.log('[Sandbox] Retrying initialization with dedicated Worker');
            await initializeWorker(sandboxPort);
            isInitialized = true;

            // Enable debug mode if requested
            if (debugMode) {
                sandboxPort.postMessage({ type: 'set_debug_mode', id: 'debug-' + Date.now(), enabled: true });
            }

            console.log('[Sandbox] Initialization complete with dedicated Worker (fallback)');
        } else {
            // Dedicated Worker also failed, propagate the error
            throw error;
        }
    }
}

/**
 * Legacy callbacks - retained as no-ops for compatibility
 */
export function setSandboxCallbacks(_callbacks: unknown): void {
    // No-op
}
