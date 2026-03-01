/**
 * Stdin Sync Bridge
 * 
 * Provides synchronous stdin reading for WASM running in a Web Worker.
 * Uses SharedArrayBuffer + Atomics.wait() to block the worker thread
 * while the main thread collects terminal input asynchronously.
 * 
 * Pattern mirrors opfs-sync-bridge.ts for filesystem operations.
 */

import { STDIN_CONTROL } from './worker-constants';
import { setTerminalSize } from './ghostty-cli-shim.js';
import { setExecutionMode, isSyncWorkerMode } from './execution-mode.js';

// ============================================================
// STATE (globalThis singleton for cross-bundle sharing)
// ============================================================

// Use globalThis symbols to share state across bundled module copies.
// When esbuild bundles stdin-sync-bridge into ghostty-cli-shim, it creates
// a separate copy with its own module-level variables. Using globalThis
// ensures the worker's initStdinSyncBridge() call initializes the same
// state that ghostty-cli-shim's blockingReadStdin() reads from.
const STDIN_BRIDGE_STATE_KEY = Symbol.for('wasi-shims:stdin-sync-bridge-state');

// Type for the shared state
interface StdinSyncBridgeState {
    controlArray: Int32Array | null;
    dataArray: Uint8Array | null;
    /** Residual bytes from a previous read where more data arrived than maxLen requested. */
    residualBuffer: Uint8Array | null;
    /** Tracks whether data was already delivered in the current input batch (mirrors JSPI hasDataBeenDelivered). */
    hasDataBeenDelivered: boolean;
}

// Get or create the shared state on globalThis
function getSharedState(): StdinSyncBridgeState {
    const g = globalThis as unknown as Record<symbol, StdinSyncBridgeState | undefined>;
    if (!g[STDIN_BRIDGE_STATE_KEY]) {
        g[STDIN_BRIDGE_STATE_KEY] = {
            controlArray: null,
            dataArray: null,
            residualBuffer: null,
            hasDataBeenDelivered: false,
        };
    }
    return g[STDIN_BRIDGE_STATE_KEY]!;
}

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
    const state = getSharedState();
    state.controlArray = control;
    state.dataArray = data;
    // Set global execution mode to sync-worker
    setExecutionMode('sync-worker');
    console.log('[StdinSyncBridge] Initialized (globalThis singleton)');
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
    const state = getSharedState();
    const { controlArray, dataArray } = state;

    if (!controlArray || !dataArray) {
        throw new Error('StdinSyncBridge not initialized');
    }

    // Check residual buffer first (leftover bytes from a previous partial read).
    // This is critical for escape sequences: the terminal delivers e.g. "\x1b[B"
    // (3 bytes) as one chunk, but WASM reads 1 byte at a time via blocking_read(1).
    // Without this, the remaining bytes would be discarded.
    if (state.residualBuffer && state.residualBuffer.length > 0) {
        const residual = state.residualBuffer;
        if (residual.length <= maxLen) {
            state.residualBuffer = null;
            state.hasDataBeenDelivered = true;
            return residual;
        }
        state.residualBuffer = residual.slice(maxLen);
        state.hasDataBeenDelivered = true;
        return residual.slice(0, maxLen);
    }

    // No residual data — if we already delivered data this batch, return empty
    // to let the render loop cycle (mirrors JSPI mode's hasDataBeenDelivered)
    if (state.hasDataBeenDelivered) {
        state.hasDataBeenDelivered = false;
        return new Uint8Array(0);
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

    // Copy all received data from shared buffer
    const fullData = dataArray.slice(0, dataLen);

    // Reset flags for next read
    Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, STDIN_CONTROL.REQUEST_READY, 0);

    // Check for resize sequence: ESC [ 8 ; rows ; cols t
    // If found, update terminal size globals before returning
    if (fullData.length >= 7 && fullData[0] === 0x1b && fullData[1] === 0x5b && fullData[2] === 0x38 && fullData[3] === 0x3b) {
        const text = new TextDecoder().decode(fullData);
        const match = text.match(/\x1b\[8;(\d+);(\d+)t/);
        if (match) {
            const rows = parseInt(match[1], 10);
            const cols = parseInt(match[2], 10);
            setTerminalSize(cols, rows);
        }
    }

    // If more data arrived than requested, save the rest for subsequent reads
    if (dataLen > maxLen) {
        state.residualBuffer = fullData.slice(maxLen);
        state.hasDataBeenDelivered = true;
        return fullData.slice(0, maxLen);
    }

    state.hasDataBeenDelivered = true;
    return fullData;
}

/**
 * Non-blocking stdin read.
 * Returns immediately with available data or empty array.
 */
export function nonBlockingReadStdin(maxLen: number): Uint8Array {
    const state = getSharedState();
    const { controlArray, dataArray } = state;

    // Check residual buffer first
    if (state.residualBuffer && state.residualBuffer.length > 0) {
        const residual = state.residualBuffer;
        if (residual.length <= maxLen) {
            state.residualBuffer = null;
            return residual;
        }
        state.residualBuffer = residual.slice(maxLen);
        return residual.slice(0, maxLen);
    }

    if (!controlArray || !dataArray) {
        return new Uint8Array(0);
    }

    // Check if response is already ready (buffered data)
    const responseReady = Atomics.load(controlArray, STDIN_CONTROL.RESPONSE_READY);

    if (responseReady === 1) {
        const dataLen = Atomics.load(controlArray, STDIN_CONTROL.DATA_LENGTH);
        const fullData = dataArray.slice(0, dataLen);

        // Reset for next read
        Atomics.store(controlArray, STDIN_CONTROL.RESPONSE_READY, 0);

        // Preserve leftover bytes
        if (dataLen > maxLen) {
            state.residualBuffer = fullData.slice(maxLen);
            return fullData.slice(0, maxLen);
        }
        return fullData;
    }

    return new Uint8Array(0);
}

/**
 * Signal EOF on stdin (e.g., when terminal closes).
 */
export function signalStdinEof(): void {
    const state = getSharedState();
    const { controlArray } = state;

    if (controlArray) {
        Atomics.store(controlArray, STDIN_CONTROL.EOF, 1);
        Atomics.notify(controlArray, STDIN_CONTROL.RESPONSE_READY);
    }
}
