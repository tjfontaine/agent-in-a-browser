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
 */

import { initStdinSyncBridge } from './stdin-sync-bridge.js';

// ============================================================
// TYPES
// ============================================================

export interface WorkerInitMessage {
    type: 'init';
    sharedBuffer: SharedArrayBuffer;
}

export interface WorkerRunMessage {
    type: 'run';
    module: 'tui' | 'mcp';
    args?: string[];
}

export interface WorkerInputMessage {
    type: 'stdin';
    data: Uint8Array;
}

export interface WorkerHttpResponseMessage {
    type: 'http-response';
    status: number;
    headers: [string, string][];
    bodyChunk: Uint8Array;
    done: boolean;
}

export interface WorkerResizeMessage {
    type: 'resize';
    cols: number;
    rows: number;
}

export type WorkerMessage =
    | WorkerInitMessage
    | WorkerRunMessage
    | WorkerInputMessage
    | WorkerHttpResponseMessage
    | WorkerResizeMessage;

// Control array layout for stdin operations
export const STDIN_CONTROL = {
    REQUEST_READY: 0,    // Worker signals it wants input
    RESPONSE_READY: 1,   // Main thread signals input available
    DATA_LENGTH: 2,      // Length of data in buffer
    EOF: 3,              // End of input stream
};

// Control array layout for HTTP operations (separate region)
export const HTTP_CONTROL = {
    REQUEST_READY: 4,    // Worker signals HTTP request
    RESPONSE_READY: 5,   // Main thread signals response ready
    STATUS_CODE: 6,      // HTTP status code
    BODY_LENGTH: 7,      // Length of body chunk
    DONE: 8,             // Response complete
};

// Buffer layout
const CONTROL_SIZE = 64;           // 16 int32s
const STDIN_BUFFER_OFFSET = 64;    // After control
const STDIN_BUFFER_SIZE = 4096;    // 4KB for stdin
const HTTP_BUFFER_OFFSET = STDIN_BUFFER_OFFSET + STDIN_BUFFER_SIZE;
const HTTP_BUFFER_SIZE = 60 * 1024; // ~60KB for HTTP

// ============================================================
// STATE
// ============================================================

let sharedBuffer: SharedArrayBuffer | null = null;
let controlArray: Int32Array | null = null;
let stdinDataArray: Uint8Array | null = null;
let httpDataArray: Uint8Array | null = null;
let initialized = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize the worker with shared memory from main thread.
 */
function initWorker(buffer: SharedArrayBuffer): void {
    sharedBuffer = buffer;
    controlArray = new Int32Array(buffer, 0, CONTROL_SIZE / 4);
    stdinDataArray = new Uint8Array(buffer, STDIN_BUFFER_OFFSET, STDIN_BUFFER_SIZE);
    httpDataArray = new Uint8Array(buffer, HTTP_BUFFER_OFFSET, HTTP_BUFFER_SIZE);

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

// ============================================================
// MESSAGE HANDLER
// ============================================================

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;

    switch (msg.type) {
        case 'init':
            initWorker(msg.sharedBuffer);
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
            // Main thread is providing HTTP response
            if (controlArray && httpDataArray) {
                httpDataArray.set(msg.bodyChunk);
                Atomics.store(controlArray, HTTP_CONTROL.STATUS_CODE, msg.status);
                Atomics.store(controlArray, HTTP_CONTROL.BODY_LENGTH, msg.bodyChunk.length);
                Atomics.store(controlArray, HTTP_CONTROL.DONE, msg.done ? 1 : 0);
                Atomics.store(controlArray, HTTP_CONTROL.RESPONSE_READY, 1);
                Atomics.notify(controlArray, HTTP_CONTROL.RESPONSE_READY);
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

                    // CRITICAL: Import from the SAME path that the transpiled TUI module uses
                    // The sync web-agent-tui.js imports from '../../../../packages/wasi-shims/src/opfs-filesystem-impl.js'
                    // Relative to this worker file (in packages/wasi-shims/src), that's just './opfs-filesystem-impl.js'
                    // However, after bundling, Vite may resolve these differently.
                    // 
                    // To ensure the same module instance, we import the TUI module FIRST (which imports the shims),
                    // then call initFilesystem from the shim the TUI module imported.
                    console.log('[WasmWorker] Loading sync web-agent-tui module (with shims)...');
                    const tuiModule = await import('../../../frontend/src/wasm/web-agent-tui-sync/web-agent-tui.js');

                    // Import initFilesystem from the SYNC path - same as what web-agent-tui-sync.js uses
                    // The sync TUI module imports from opfs-filesystem-sync-impl.js, NOT opfs-filesystem-impl.js
                    const opfsShim = await import('./opfs-filesystem-sync-impl.js');

                    // DEBUG: Check if the Descriptor classes are the same
                    const shimDescriptor = opfsShim.types?.Descriptor;
                    const rootDirs = opfsShim.preopens?.getDirectories?.();
                    const rootDesc = rootDirs?.[0]?.[0];
                    console.log('[WasmWorker] DEBUG - Descriptor class name:', shimDescriptor?.name);
                    console.log('[WasmWorker] DEBUG - rootDesc constructor:', rootDesc?.constructor?.name);
                    console.log('[WasmWorker] DEBUG - rootDesc instanceof Descriptor:', rootDesc instanceof shimDescriptor);
                    console.log('[WasmWorker] DEBUG - Same class?:', rootDesc?.constructor === shimDescriptor ? 'YES' : 'NO');

                    await opfsShim.initFilesystem();
                    console.log('[WasmWorker] OPFS filesystem ready');

                    // CRITICAL: Pre-load all lazy modules in the worker context
                    // The worker has its own lazy-modules.ts with an empty loadedModules map.
                    // We must call initializeForSyncMode() HERE to populate the worker's cache.
                    console.log('[WasmWorker] Pre-loading all lazy modules...');
                    const { initializeForSyncMode } = await import('../../../frontend/src/wasm/lazy-loading/lazy-modules.js');
                    await initializeForSyncMode();
                    console.log('[WasmWorker] Lazy modules pre-loaded');

                    // Set up sync transport handler for MCP requests
                    // Route localhost:3000 MCP requests through Atomics-based sync bridge
                    // Pass isSyncMode=true so wasi-http-impl doesn't use async lazy streams
                    const { setTransportHandler } = await import('./wasi-http-impl.js');
                    setTransportHandler((method, url, headers, body) => {
                        // This handler is called for localhost MCP requests
                        // Use blockingHttpRequest which blocks via Atomics.wait
                        const response = blockingHttpRequest(method, url, headers, body);
                        // Return as syncValue marker - NOT Promise - so wasi-http-impl can bypass async path
                        // This is critical for Safari which can't suspend at async/await in WASM call stack
                        return {
                            syncValue: {
                                status: response.status,
                                headers: response.headers.map(([k, v]) => [k, new TextEncoder().encode(v)] as [string, Uint8Array]),
                                body: response.body
                            }
                        };
                    }, true); // isSyncMode = true - don't use async lazy streams
                    console.log('[WasmWorker] Sync MCP transport handler registered');

                    // Await $init for sync module initialization
                    if (tuiModule.$init) {
                        console.log('[WasmWorker] Awaiting TUI module $init...');
                        await tuiModule.$init;
                    }

                    console.log('[WasmWorker] TUI module loaded, starting run()...');
                    self.postMessage({ type: 'started', module: msg.module });

                    // Run the TUI - this will block in sync mode, using Atomics.wait
                    // for stdin reads. The shims should be configured via the transpiled module.
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

