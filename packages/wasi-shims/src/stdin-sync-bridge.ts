/**
 * Stdin Sync Bridge
 * 
 * Provides synchronous stdin reading for WASM running in a Web Worker.
 * Uses SharedArrayBuffer + Atomics.wait() to block the worker thread
 * while the main thread collects terminal input asynchronously.
 * 
 * Pattern mirrors opfs-sync-bridge.ts for filesystem operations.
 */

import { STDIN_CONTROL } from './wasm-worker';
import { setTerminalSize } from './ghostty-cli-shim.js';
import { setExecutionMode, isSyncWorkerMode } from './execution-mode.js';

// ============================================================
// STATE (initialized by worker)
// ============================================================

let controlArray: Int32Array | null = null;
let dataArray: Uint8Array | null = null;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize the sync bridge with shared memory.
 * Called from wasm-worker.ts during initialization.
 */
export function initStdinSyncBridge(
    control: Int32Array,
    data: Uint8Array
): void {
    controlArray = control;
    dataArray = data;
    // Set global execution mode to sync-worker
    setExecutionMode('sync-worker');
    console.log('[StdinSyncBridge] Initialized');
}

/**
 * Check if we're in worker mode (non-JSPI).
 * @deprecated Use isSyncWorkerMode() from execution-mode.ts instead
 */
export function isNonJspiMode(): boolean {
    return isSyncWorkerMode();
}

// ============================================================
// SYNC OPERATIONS (called from shims in worker)
// ============================================================

/**
 * Synchronously read stdin data.
 * Blocks via Atomics.wait() until main thread provides input.
 * 
 * @param maxLen Maximum bytes to read
 * @returns The stdin data, or empty array on EOF/timeout
 */
export function blockingReadStdin(maxLen: number): Uint8Array {
    if (!controlArray || !dataArray) {
        throw new Error('StdinSyncBridge not initialized');
    }

    // Check for EOF
    if (Atomics.load(controlArray, STDIN_CONTROL.EOF) === 1) {
        return new Uint8Array(0);
    }

    // Signal we want input
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 1);

    // Notify main thread we're waiting for stdin
    // This triggers handleStdinRequest() which sends buffered keyboard data
    self.postMessage({ type: 'stdin-request', maxLen });

    // Block until input is available (50ms timeout for responsive rendering)
    // Short timeout allows Rust TUI's handle_input() loop to exit quickly,
    // enabling render() to be called after each input batch
    const waitResult = Atomics.wait(controlArray, STDIN_CONTROL.RESPONSE_READY, 0, 50);

    if (waitResult === 'timed-out') {
        // Timeout is expected - allows render loop to cycle
        Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 0);
        return new Uint8Array(0);
    }

    // Read the data length
    const dataLen = Atomics.load(controlArray, STDIN_CONTROL.DATA_LENGTH);
    console.log(`[StdinSyncBridge] Read dataLen=${dataLen}`);

    // Copy data from shared buffer (don't just slice - need a copy)
    const result = dataArray.slice(0, Math.min(dataLen, maxLen));
    console.log(`[StdinSyncBridge] Returning ${result.length} bytes: ${new TextDecoder().decode(result)}`);

    // Check for resize sequence: ESC [ 8 ; rows ; cols t
    // If found, update terminal size globals before returning
    if (result.length >= 7 && result[0] === 0x1b && result[1] === 0x5b && result[2] === 0x38 && result[3] === 0x3b) {
        const text = new TextDecoder().decode(result);
        const match = text.match(/\x1b\[8;(\d+);(\d+)t/);
        if (match) {
            const rows = parseInt(match[1], 10);
            const cols = parseInt(match[2], 10);
            console.log(`[StdinSyncBridge] Detected resize sequence, updating terminal size: ${cols}x${rows}`);
            setTerminalSize(cols, rows);
        }
    }

    // Reset flags for next read
    Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 0);

    return result;
}

/**
 * Non-blocking stdin read.
 * Returns immediately with available data or empty array.
 */
export function nonBlockingReadStdin(maxLen: number): Uint8Array {
    if (!controlArray || !dataArray) {
        return new Uint8Array(0);
    }

    // Check if response is already ready (buffered data)
    const responseReady = Atomics.load(controlArray, STDIN_CONTROL.RESPONSE_READY);

    if (responseReady === 1) {
        const dataLen = Atomics.load(controlArray, STDIN_CONTROL.DATA_LENGTH);
        const result = dataArray.slice(0, Math.min(dataLen, maxLen));

        // Reset for next read
        Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);
        return result;
    }

    return new Uint8Array(0);
}

/**
 * Signal EOF on stdin (e.g., when terminal closes).
 */
export function signalStdinEof(): void {
    if (controlArray) {
        Atomics.store(controlArray, STDIN_CONTROL.EOF, 1);
        Atomics.notify(controlArray, STDIN_CONTROL.RESPONSE_READY);
    }
}
