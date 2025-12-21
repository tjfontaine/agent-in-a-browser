/**
 * Sandbox Worker Management
 * 
 * Manages the sandbox worker for MCP tool execution via workerFetch.
 */

import { createWorkerFetch } from '../worker-fetch';

// ============ Worker Instance ============

const sandbox = new Worker(new URL('../sandbox-worker.ts', import.meta.url), { type: 'module' });

// ============ Worker Fetch ============

/**
 * Fetch-like function to communicate with the sandbox worker
 */
export const fetchFromSandbox = createWorkerFetch(sandbox);

// ============ Initialization ============

/**
 * Initialize the sandbox worker.
 * Waits for worker to signal ready, then sends init message.
 */
export function initializeSandbox(): Promise<void> {
    console.log('[Sandbox] initializeSandbox() called');
    return new Promise((resolve, reject) => {
        const handler = (event: MessageEvent) => {
            console.log('[Sandbox] Received message from worker:', event.data);
            const { type, id: _id } = event.data;

            if (type === 'ready') {
                // Worker is loaded and ready, now send init
                console.log('[Sandbox] Worker ready, sending init message');
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

        // Worker will self-signal when ready (no need to send init right away)
        console.log('[Sandbox] Waiting for worker ready signal...');
    });
}

/**
 * Legacy callbacks - retained as no-ops or for partial compatibility if needed,
 * but mostly deprecated as the worker no longer emits these events via postMessage.
 */
export function setSandboxCallbacks(_callbacks: unknown): void {
    // No-op
}



