/**
 * WASM Worker for Non-JSPI Browsers (Safari)
 * 
 * Hosts the WASM runtime in a dedicated Web Worker, using Atomics.wait()
 * for synchronous blocking on async operations (stdin, HTTP, etc.).
 * 
 * This enables full TUI functionality on Safari without JSPI by:
 * 1. Running WASM in this worker thread
 * 2. Blocking on Atomics.wait() when WASM calls blocking operations
 * 3. Main thread performs async ops and wakes via Atomics.notify()
 * 
 * NOTE: This file lives in frontend because it imports from frontend modules.
 * The WorkerBridge in wasi-shims accepts a worker URL parameter.
 */

import { initStdinSyncBridge } from '@tjfontaine/wasi-shims/stdin-sync-bridge.js';
import {
    STDIN_CONTROL,
    HTTP_CONTROL,
    BUFFER_LAYOUT,
    type WorkerMessage,
} from '@tjfontaine/wasi-shims/worker-constants.js';

// Re-export for type compatibility
export { STDIN_CONTROL, HTTP_CONTROL, BUFFER_LAYOUT } from '@tjfontaine/wasi-shims/worker-constants.js';
export type {
    WorkerInitMessage,
    WorkerRunMessage,
    WorkerInputMessage,
    WorkerHttpResponseMessage,
    WorkerHttpHeadersMessage,
    WorkerResizeMessage,
    WorkerMessage,
} from '@tjfontaine/wasi-shims/worker-constants.js';

// Buffer layout derived from constants
const CONTROL_SIZE = BUFFER_LAYOUT.CONTROL_SIZE;
const STDIN_BUFFER_OFFSET = BUFFER_LAYOUT.STDIN_BUFFER_OFFSET;
const STDIN_BUFFER_SIZE = BUFFER_LAYOUT.STDIN_BUFFER_SIZE;
const HTTP_BUFFER_OFFSET = BUFFER_LAYOUT.HTTP_BUFFER_OFFSET;
const HTTP_BUFFER_SIZE = BUFFER_LAYOUT.HTTP_BUFFER_SIZE;

// ============================================================
// STATE
// ============================================================

let controlArray: Int32Array | null = null;
let stdinDataArray: Uint8Array | null = null;
let httpDataArray: Uint8Array | null = null;
let opfsSharedBuffer: SharedArrayBuffer | null = null;
let initialized = false;

// Pending HTTP response headers (sent via postMessage, stored here for streaming)
let pendingHttpHeaders: { status: number; headers: [string, string][] } | null = null;

// Helper function to read pendingHttpHeaders without TypeScript control flow analysis
// This prevents TS from narrowing the value to 'never' after setting it to null
function getPendingHttpHeaders(): { status: number; headers: [string, string][] } | null {
    return pendingHttpHeaders;
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize the worker with shared memory from main thread.
 * @param buffer SharedArrayBuffer for stdin/http communication
 * @param opfsBuffer SharedArrayBuffer for OPFS worker communication (required for WebKit)
 */
function initWorker(buffer: SharedArrayBuffer, opfsBuffer: SharedArrayBuffer): void {
    // Store buffers for stdin/http communication
    controlArray = new Int32Array(buffer, 0, CONTROL_SIZE / 4);
    stdinDataArray = new Uint8Array(buffer, STDIN_BUFFER_OFFSET, STDIN_BUFFER_SIZE);
    httpDataArray = new Uint8Array(buffer, HTTP_BUFFER_OFFSET, HTTP_BUFFER_SIZE);

    // Store OPFS buffer for filesystem initialization
    // In WebKit workers, SharedArrayBuffer is not available, so it must be passed from main thread
    opfsSharedBuffer = opfsBuffer;

    // Clear control flags
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 0);
    Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, STDIN_CONTROL.EOF, 0);
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);
    Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 0);

    // Initialize stdin sync bridge so ghostty-cli-shim knows we're in worker mode
    initStdinSyncBridge(controlArray, stdinDataArray);

    initialized = true;
    console.log('[WasmWorker] Initialized with SharedArrayBuffer');

    // Notify main thread we're ready
    self.postMessage({ type: 'ready' });
}

// ============================================================
// BLOCKING OPERATIONS (called from shims)
// ============================================================

/**
 * Synchronously read stdin data.
 * Blocks via Atomics.wait() until main thread provides input.
 */
export function blockingReadStdin(maxLen: number): Uint8Array {
    if (!controlArray || !stdinDataArray) {
        throw new Error('Worker not initialized');
    }

    // Check for EOF
    if (Atomics.load(controlArray, STDIN_CONTROL.EOF) === 1) {
        return new Uint8Array(0);
    }

    // Signal we want input
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 1);

    // Notify main thread (in case it's waiting)
    self.postMessage({ type: 'stdin-request', maxLen });

    // Block until input is available (30 second timeout)
    const waitResult = Atomics.wait(controlArray, STDIN_CONTROL.RESPONSE_READY, 0, 30000);

    if (waitResult === 'timed-out') {
        console.warn('[WasmWorker] stdin read timed out');
        return new Uint8Array(0);
    }

    // Read the data
    const dataLen = Atomics.load(controlArray, STDIN_CONTROL.DATA_LENGTH);
    const data = stdinDataArray.slice(0, Math.min(dataLen, maxLen));

    // Reset flags
    Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 0);

    return data;
}

/**
 * Synchronously perform HTTP request.
 * Blocks via Atomics.wait() until main thread completes fetch.
 */
export function blockingHttpRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
): { status: number; headers: [string, string][]; body: Uint8Array } {
    if (!controlArray || !httpDataArray) {
        throw new Error('Worker not initialized');
    }

    // Send request to main thread
    self.postMessage({
        type: 'http-request',
        method,
        url,
        headers,
        body: body ? Array.from(body) : null
    });

    // Signal request is ready
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 1);

    // Block until response is available
    console.log('[WasmWorker] Waiting for HTTP response via Atomics.wait...');
    const currentValue = Atomics.load(controlArray, HTTP_CONTROL.RESPONSE_READY);
    console.log('[WasmWorker] RESPONSE_READY current value:', currentValue);

    const waitResult = Atomics.wait(controlArray, HTTP_CONTROL.RESPONSE_READY, 0, 60000);
    console.log('[WasmWorker] Atomics.wait returned:', waitResult);

    if (waitResult === 'timed-out') {
        console.error('[WasmWorker] HTTP request timed out');
        return { status: 0, headers: [], body: new Uint8Array(0) };
    }

    // Read response from shared buffer
    const status = Atomics.load(controlArray, HTTP_CONTROL.STATUS_CODE);
    const bodyLen = Atomics.load(controlArray, HTTP_CONTROL.BODY_LENGTH);
    console.log('[WasmWorker] HTTP response status:', status, 'bodyLen:', bodyLen);
    const responseBody = httpDataArray.slice(0, bodyLen);

    // Reset flags
    Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);

    // Headers are sent via postMessage, not SharedArrayBuffer
    // Main thread will have sent them before notifying
    return { status, headers: [], body: responseBody };
}

/**
 * Result type for streaming HTTP response chunks.
 */
export interface HttpStreamChunk {
    status: number;           // HTTP status (only valid on first chunk)
    headers: [string, string][]; // Response headers (only valid on first chunk)
    chunk: Uint8Array;        // Body chunk data
    done: boolean;            // True if this is the last chunk (EOF)
}

/**
 * Streaming HTTP request using a generator pattern.
 * Yields chunks as they arrive from the main thread.
 * Blocks via Atomics.wait() on each chunk.
 * 
 * @param method HTTP method
 * @param url Request URL
 * @param headers Request headers
 * @param body Request body (optional)
 * @yields HttpStreamChunk for each chunk of response data
 */
export function* blockingHttpRequestStreaming(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
): Generator<HttpStreamChunk, void, unknown> {
    if (!controlArray || !httpDataArray) {
        throw new Error('Worker not initialized');
    }

    // Clear any pending headers from previous request
    pendingHttpHeaders = null;

    // Send request to main thread
    self.postMessage({
        type: 'http-request',
        method,
        url,
        headers,
        body: body ? Array.from(body) : null
    });

    // Signal request is ready
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 1);
    console.log('[WasmWorker] Streaming HTTP request started:', method, url);

    let isFirst = true;

    while (true) {
        // Wait for next chunk (or headers on first iteration)
        const waitResult = Atomics.wait(controlArray, HTTP_CONTROL.RESPONSE_READY, 0, 60000);

        if (waitResult === 'timed-out') {
            console.error('[WasmWorker] HTTP streaming timed out');
            Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);
            yield { status: 0, headers: [], chunk: new Uint8Array(0), done: true };
            return;
        }

        // Read chunk info from shared buffer
        const status = isFirst ? Atomics.load(controlArray, HTTP_CONTROL.STATUS_CODE) : 0;
        const chunkLen = Atomics.load(controlArray, HTTP_CONTROL.BODY_LENGTH);
        const isDone = Atomics.load(controlArray, HTTP_CONTROL.DONE) === 1;

        // Copy chunk data
        const chunk = httpDataArray.slice(0, chunkLen);

        // Get headers from pending (sent via postMessage) on first chunk
        // Use helper function to avoid TypeScript control flow narrowing to 'never'
        // (pendingHttpHeaders is set asynchronously by message handler)
        const pendingHeaders = getPendingHttpHeaders();
        const responseHeaders = isFirst && pendingHeaders ? pendingHeaders.headers : [];

        // Reset response ready flag
        Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 0);

        // Signal we consumed this chunk (so main thread can send next)
        Atomics.store(controlArray, HTTP_CONTROL.CHUNK_CONSUMED, 1);
        Atomics.notify(controlArray, HTTP_CONTROL.CHUNK_CONSUMED);

        console.log(`[WasmWorker] Streaming chunk: ${chunkLen} bytes, done=${isDone}`);

        yield {
            status: isFirst ? (pendingHeaders?.status ?? status) : 0,
            headers: responseHeaders,
            chunk,
            done: isDone
        };

        if (isDone) {
            break;
        }

        isFirst = false;
    }

    // Clean up
    Atomics.store(controlArray, HTTP_CONTROL.REQUEST_READY, 0);
    pendingHttpHeaders = null;
    console.log('[WasmWorker] Streaming HTTP request complete');
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;

    switch (msg.type) {
        case 'init':
            initWorker(msg.sharedBuffer, msg.opfsSharedBuffer);
            break;

        case 'stdin':
            // Main thread is providing stdin data
            if (controlArray && stdinDataArray && msg.data) {
                stdinDataArray.set(msg.data);
                Atomics.store(controlArray, STDIN_CONTROL.DATA_LENGTH, msg.data.length);
                Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 1);
                Atomics.notify(controlArray, STDIN_CONTROL.RESPONSE_READY);
            }
            break;

        case 'resize':
            // Main thread is sending terminal resize event
            console.log('[WasmWorker] Received resize message:', msg.cols, 'x', msg.rows);
            // Inject DECSLPP escape sequence into stdin buffer
            // CSI 8 ; rows ; cols t
            if (controlArray && stdinDataArray && msg.cols && msg.rows) {
                const resizeSequence = `\x1b[8;${msg.rows};${msg.cols}t`;
                const bytes = new TextEncoder().encode(resizeSequence);
                stdinDataArray.set(bytes);
                Atomics.store(controlArray, STDIN_CONTROL.DATA_LENGTH, bytes.length);
                Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 1);
                Atomics.notify(controlArray, STDIN_CONTROL.RESPONSE_READY);
                console.log('[WasmWorker] Resize injected as stdin:', msg.cols, 'x', msg.rows);
            } else {
                console.log('[WasmWorker] Resize skipped - missing controlArray/stdinDataArray or cols/rows');
            }
            break;

        case 'http-response':
            // Main thread is providing HTTP response (legacy full-buffer or streaming chunk)
            if (controlArray && httpDataArray) {
                httpDataArray.set(msg.bodyChunk);
                Atomics.store(controlArray, HTTP_CONTROL.STATUS_CODE, msg.status);
                Atomics.store(controlArray, HTTP_CONTROL.BODY_LENGTH, msg.bodyChunk.length);
                Atomics.store(controlArray, HTTP_CONTROL.DONE, msg.done ? 1 : 0);
                Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 1);
                Atomics.notify(controlArray, HTTP_CONTROL.RESPONSE_READY);
            }
            break;

        case 'http-headers':
            // Main thread is sending HTTP response headers (for streaming mode)
            // Store them for the streaming generator to pick up
            pendingHttpHeaders = {
                status: msg.status,
                headers: msg.headers
            };
            // Signal headers are ready (in case generator is waiting)
            if (controlArray) {
                Atomics.store(controlArray, HTTP_CONTROL.HEADERS_READY, 1);
                Atomics.notify(controlArray, HTTP_CONTROL.HEADERS_READY);
            }
            break;

        case 'run':
            // Start WASM execution
            if (!initialized) {
                self.postMessage({ type: 'error', message: 'Worker not initialized' });
                return;
            }

            try {
                if (msg.module === 'tui') {
                    console.log('[WasmWorker] Initializing OPFS filesystem for TUI...');

                    // Load sync TUI module (imports shims via package paths)
                    console.log('[WasmWorker] Loading sync web-agent-tui module (with shims)...');
                    const tuiModule = await import('../wasm/web-agent-tui-sync/web-agent-tui.js');

                    // Import filesystem shim and initialize
                    const opfsShim = await import('@tjfontaine/wasi-shims/opfs-filesystem-sync-impl.js');

                    // DEBUG: Check if the Descriptor classes are the same
                    const shimDescriptor = opfsShim.types?.Descriptor;
                    const rootDirs = opfsShim.preopens?.getDirectories?.();
                    const rootDesc = rootDirs?.[0]?.[0];
                    console.log('[WasmWorker] DEBUG - Descriptor class name:', shimDescriptor?.name);
                    console.log('[WasmWorker] DEBUG - rootDesc constructor:', rootDesc?.constructor?.name);
                    console.log('[WasmWorker] DEBUG - rootDesc instanceof Descriptor:', rootDesc instanceof shimDescriptor);
                    console.log('[WasmWorker] DEBUG - Same class?:', rootDesc?.constructor === shimDescriptor ? 'YES' : 'NO');

                    // Initialize OPFS with buffer from main thread (required for WebKit)
                    await opfsShim.initFilesystem(opfsSharedBuffer!);
                    console.log('[WasmWorker] OPFS filesystem ready');

                    // Pre-load all lazy modules in the worker context
                    console.log('[WasmWorker] Pre-loading all lazy modules...');
                    const { initializeForSyncMode } = await import('../wasm/lazy-loading/lazy-modules.js');
                    await initializeForSyncMode();
                    console.log('[WasmWorker] Lazy modules pre-loaded');

                    // Set up sync transport handler for MCP requests
                    const { setTransportHandler, setStreamingTransportHandler } = await import('@tjfontaine/wasi-shims/wasi-http-impl.js');

                    // Legacy sync transport handler (for backwards compatibility)
                    setTransportHandler((method, url, headers, body) => {
                        const response = blockingHttpRequest(method, url, headers, body);
                        return {
                            syncValue: {
                                status: response.status,
                                headers: response.headers.map(([k, v]) => [k, new TextEncoder().encode(v)] as [string, Uint8Array]),
                                body: response.body
                            }
                        };
                    }, true); // isSyncMode = true

                    // Streaming transport handler
                    setStreamingTransportHandler(function* (method, url, headers, body) {
                        const generator = blockingHttpRequestStreaming(method, url, headers, body);
                        for (const chunk of generator) {
                            yield {
                                status: chunk.status,
                                headers: chunk.headers.map(([k, v]) => [k, new TextEncoder().encode(v)] as [string, Uint8Array]),
                                chunk: chunk.chunk,
                                done: chunk.done
                            };
                        }
                    });
                    console.log('[WasmWorker] Sync MCP transport handler registered (with streaming support)');

                    // Await $init for sync module initialization
                    if (tuiModule.$init) {
                        console.log('[WasmWorker] Awaiting TUI module $init...');
                        await tuiModule.$init;
                    }

                    console.log('[WasmWorker] TUI module loaded, starting run()...');
                    self.postMessage({ type: 'started', module: msg.module });

                    // Run the TUI
                    try {
                        const exitCode = tuiModule.run();
                        console.log('[WasmWorker] TUI exited with code:', exitCode);
                        self.postMessage({ type: 'exit', code: exitCode });
                    } catch (err) {
                        console.error('[WasmWorker] TUI execution error:', err);
                        self.postMessage({ type: 'error', message: String(err) });
                    }
                } else {
                    console.log(`[WasmWorker] Unknown module: ${msg.module}`);
                    self.postMessage({ type: 'error', message: `Unknown module: ${msg.module}` });
                }
            } catch (err) {
                console.error('[WasmWorker] Module load error:', err);
                self.postMessage({ type: 'error', message: String(err) });
            }
            break;
    }
};

// Export for type checking
