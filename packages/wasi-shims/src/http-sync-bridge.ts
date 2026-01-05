/**
 * HTTP Sync Bridge
 * 
 * Provides synchronous HTTP requests for WASM running in a Web Worker.
 * Uses SharedArrayBuffer + Atomics.wait() to block the worker thread
 * while the main thread performs fetch() asynchronously.
 * 
 * Pattern mirrors opfs-sync-bridge.ts for filesystem operations.
 */

import { HTTP_CONTROL } from './wasm-worker';

// ============================================================
// STATE (initialized by worker)
// ============================================================

let controlArray: Int32Array | null = null;
let dataArray: Uint8Array | null = null;
let isWorkerMode = false;

// Response headers are sent via postMessage since they're variable-length
let pendingHeaders: [string, string][] = [];

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize the sync bridge with shared memory.
 * Called from wasm-worker.ts during initialization.
 */
export function initHttpSyncBridge(
    control: Int32Array,
    data: Uint8Array
): void {
    controlArray = control;
    dataArray = data;
    isWorkerMode = true;
    console.log('[HttpSyncBridge] Initialized');
}

/**
 * Set response headers (called from message handler).
 */
export function setResponseHeaders(headers: [string, string][]): void {
    pendingHeaders = headers;
}

// ============================================================
// SYNC OPERATIONS (called from shims in worker)
// ============================================================

export interface SyncHttpResponse {
    status: number;
    headers: [string, string][];
    body: Uint8Array;
}

/**
 * Synchronously perform HTTP request.
 * Blocks via Atomics.wait() until main thread completes fetch.
 * 
 * @param method HTTP method
 * @param url Request URL
 * @param headers Request headers
 * @param body Request body (optional)
 * @returns Response with status, headers, and body
 */
export function blockingHttpRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
): SyncHttpResponse {
    if (!controlArray || !dataArray) {
        throw new Error('HttpSyncBridge not initialized');
    }

    // Clear pending headers
    pendingHeaders = [];

    // NOTE: The worker sends the request via postMessage.
    // This function is called after that, so we just wait for response.

    // Signal request is ready
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 1);

    // Block until response is available (60 second timeout for HTTP)
    const waitResult = Atomics.wait(controlArray, HTTP_CONTROL.RESPONSE_READY, 0, 60000);

    if (waitResult === 'timed-out') {
        console.error('[HttpSyncBridge] HTTP request timed out');
        Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);
        return { status: 0, headers: [], body: new Uint8Array(0) };
    }

    // Read response from shared buffer
    const status = Atomics.load(controlArray, HTTP_CONTROL.STATUS_CODE);
    const bodyLen = Atomics.load(controlArray, HTTP_CONTROL.BODY_LENGTH);

    // Copy body from shared buffer
    const responseBody = dataArray.slice(0, bodyLen);

    // Reset flags for next request
    Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);

    return {
        status,
        headers: pendingHeaders,
        body: responseBody
    };
}

/**
 * Check if a request is currently in progress.
 */
export function isRequestPending(): boolean {
    if (!controlArray) return false;
    return Atomics.load(controlArray, HTTP_CONTROL.REQUEST_READY) === 1;
}
