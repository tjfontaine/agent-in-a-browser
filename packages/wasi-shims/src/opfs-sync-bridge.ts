/**
 * OPFS Sync Helper Bridge
 * 
 * Handles synchronous communication with the async OPFS helper worker
 * using SharedArrayBuffer and Atomics.wait().
 */

// ============================================================
// TYPES
// ============================================================

export interface OPFSRequest {
    type: 'scanDirectory' | 'acquireSyncHandle';
    path: string;
}

export interface DirectoryEntryData {
    name: string;
    kind: 'file' | 'directory';
    size?: number;
    mtime?: number;
}

export interface OPFSResponse {
    success: boolean;
    entries?: DirectoryEntryData[];
    error?: string;
}

export interface SyncFileRequest {
    type: 'readFile' | 'writeFile' | 'readFileBinary' | 'writeFileBinary' | 'exists' | 'stat' | 'mkdir' | 'rmdir' | 'unlink';
    path: string;
    data?: string;
    recursive?: boolean;
    binaryOffset?: number;  // For writeFileBinary: where binary data starts in dataArray
    binaryLength?: number;  // For writeFileBinary: length of binary data
}

export interface SyncFileResponse {
    success: boolean;
    data?: string;           // For readFile (text)
    size?: number;
    mtime?: number;
    isFile?: boolean;
    isDirectory?: boolean;
    error?: string;
    binaryOffset?: number;   // For readFileBinary: where binary data is in dataArray
    binaryLength?: number;   // For readFileBinary: length of binary data
}

// ============================================================
// STATE
// ============================================================

let helperWorker: Worker | null = null;
let sharedBuffer: SharedArrayBuffer | null = null;
let controlArray: Int32Array | null = null;
let dataArray: Uint8Array | null = null;
let helperReady = false;

// Control array layout (matches opfs-async-helper.ts)
const CONTROL = {
    REQUEST_READY: 0,
    RESPONSE_READY: 1,
    DATA_LENGTH: 2,
    SHUTDOWN: 3,
};

// ============================================================
// INITIALIZATION
// ============================================================

export function isHelperReady(): boolean {
    return helperReady;
}

export function getSharedBuffer(): SharedArrayBuffer | null {
    return sharedBuffer;
}

export function getControlArray(): Int32Array | null {
    return controlArray;
}

export function getDataArray(): Uint8Array | null {
    return dataArray;
}

/**
 * Check if SharedArrayBuffer is available in the current context.
 * Requires cross-origin isolation (COOP/COEP headers).
 */
export function isSharedArrayBufferAvailable(): boolean {
    // Check if we're in a cross-origin isolated context
    // This is the proper way to detect SAB availability per MDN
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
        return typeof SharedArrayBuffer !== 'undefined';
    }

    // Fallback: try to detect SAB directly (some environments don't have crossOriginIsolated)
    return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Initialize the helper worker and shared memory.
 * Returns a promise that resolves when the helper is ready.
 * 
 * This is only used in non-JSPI mode (Safari/Firefox) where we need
 * synchronous blocking via Atomics.wait().
 */
export async function initHelperWorker(): Promise<void> {
    if (helperReady) return;

    // Verify SharedArrayBuffer is available before attempting to use it
    if (!isSharedArrayBufferAvailable()) {
        const isCOI = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined';
        console.error('[opfs-sync-bridge] SharedArrayBuffer not available.', {
            crossOriginIsolated: isCOI,
            sharedArrayBufferType: typeof SharedArrayBuffer,
            hint: 'Ensure COOP/COEP headers are set: Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp'
        });
        throw new Error('SharedArrayBuffer not available - cross-origin isolation required');
    }

    // Create shared buffer for communication with helper worker
    // 64KB should be plenty for directory listings
    sharedBuffer = new SharedArrayBuffer(64 * 1024);
    controlArray = new Int32Array(sharedBuffer, 0, 16);
    dataArray = new Uint8Array(sharedBuffer, 64);

    // Initialize control flags
    Atomics.store(controlArray, CONTROL.REQUEST_READY, 0);
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, CONTROL.SHUTDOWN, 0);

    // Spawn helper worker
    helperWorker = new Worker(
        new URL('./opfs-async-helper.js', import.meta.url),
        { type: 'module' }
    );

    // Wait for helper to be ready
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Helper worker timeout')), 5000);

        helperWorker!.onmessage = (e) => {
            if (e.data.type === 'ready') {
                clearTimeout(timeout);
                helperReady = true;
                resolve();
            }
        };

        helperWorker!.onerror = (e) => {
            clearTimeout(timeout);
            reject(e);
        };

        // Send shared buffer to helper
        helperWorker!.postMessage({ type: 'init', buffer: sharedBuffer });
    });
}

// ============================================================
// SYNC OPERATIONS
// ============================================================

/**
 * Execute a file operation synchronously via the helper worker.
 * Uses Atomics.wait() to block until the helper completes.
 */
export function syncFileOperation(request: SyncFileRequest): SyncFileResponse {
    if (!sharedBuffer || !controlArray || !dataArray || !helperReady) {
        throw new Error('OPFS helper not ready for sync file operations');
    }

    const requestBytes = new TextEncoder().encode(JSON.stringify(request));
    dataArray.set(requestBytes);
    Atomics.store(controlArray, CONTROL.DATA_LENGTH, requestBytes.length);
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, CONTROL.REQUEST_READY, 1);
    Atomics.notify(controlArray, CONTROL.REQUEST_READY);

    const waitResult = Atomics.wait(controlArray, CONTROL.RESPONSE_READY, 0, 30000);
    if (waitResult === 'timed-out') {
        throw new Error('Timeout waiting for file operation');
    }

    const responseLength = Atomics.load(controlArray, CONTROL.DATA_LENGTH);
    const responseJson = new TextDecoder().decode(dataArray.slice(0, responseLength));
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);

    return JSON.parse(responseJson);
}

/**
 * Synchronously read a file's contents.
 */
export function syncReadFile(path: string): string {
    const response = syncFileOperation({ type: 'readFile', path });
    if (!response.success) {
        throw new Error(response.error || `ENOENT: no such file: ${path}`);
    }
    return response.data || '';
}

/**
 * Synchronously write data to a file.
 */
export function syncWriteFile(path: string, data: string): void {
    const response = syncFileOperation({ type: 'writeFile', path, data });
    if (!response.success) {
        throw new Error(response.error || `Failed to write: ${path}`);
    }
}

/**
 * Synchronously read a file's binary contents.
 * Returns the raw bytes without any text encoding/decoding.
 */
export function syncReadFileBinary(path: string): Uint8Array {
    if (!dataArray) {
        throw new Error('OPFS helper not ready for binary operations');
    }

    const response = syncFileOperation({ type: 'readFileBinary', path });
    if (!response.success || response.binaryOffset === undefined || response.binaryLength === undefined) {
        throw new Error(response.error || `ENOENT: no such file: ${path}`);
    }

    // Copy binary data from dataArray (don't just slice - we need a copy)
    return dataArray.slice(response.binaryOffset, response.binaryOffset + response.binaryLength);
}

/**
 * Synchronously write binary data to a file.
 * Writes raw bytes without any text encoding/decoding.
 */
export function syncWriteFileBinary(path: string, data: Uint8Array): void {
    if (!sharedBuffer || !controlArray || !dataArray || !helperReady) {
        throw new Error('OPFS helper not ready for binary operations');
    }

    // Binary data goes at fixed offset (after the JSON request)
    const binaryOffset = 1024;
    const maxBinarySize = dataArray.length - binaryOffset;

    if (data.length > maxBinarySize) {
        throw new Error(`Binary data too large: ${data.length} > ${maxBinarySize}`);
    }

    // Copy binary data to dataArray
    dataArray.set(data, binaryOffset);

    // Make request with binary offset/length
    const request: SyncFileRequest = {
        type: 'writeFileBinary',
        path,
        binaryOffset,
        binaryLength: data.length
    };

    const requestBytes = new TextEncoder().encode(JSON.stringify(request));

    // Don't overwrite the binary data area
    if (requestBytes.length > binaryOffset) {
        throw new Error('Request JSON too large for binary operation');
    }

    dataArray.set(requestBytes);
    Atomics.store(controlArray, CONTROL.DATA_LENGTH, requestBytes.length);
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, CONTROL.REQUEST_READY, 1);
    Atomics.notify(controlArray, CONTROL.REQUEST_READY);

    const waitResult = Atomics.wait(controlArray, CONTROL.RESPONSE_READY, 0, 30000);
    if (waitResult === 'timed-out') {
        throw new Error('Timeout waiting for binary write');
    }

    const responseLength = Atomics.load(controlArray, CONTROL.DATA_LENGTH);
    const responseJson = new TextDecoder().decode(dataArray.slice(0, responseLength));
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);

    const response: SyncFileResponse = JSON.parse(responseJson);
    if (!response.success) {
        throw new Error(response.error || `Failed to write: ${path}`);
    }
}

/**
 * Synchronously check if a path exists.
 */
export function syncExists(path: string): boolean {
    const response = syncFileOperation({ type: 'exists', path });
    return response.success;
}

/**
 * Synchronously get file/directory stats.
 */
export function syncStat(path: string): { size: number; isFile: boolean; isDirectory: boolean; mtime?: number } {
    const response = syncFileOperation({ type: 'stat', path });
    if (!response.success) {
        throw new Error(response.error || `ENOENT: ${path}`);
    }
    return {
        size: response.size || 0,
        isFile: response.isFile || false,
        isDirectory: response.isDirectory || false,
        mtime: response.mtime
    };
}

/**
 * Synchronously create a directory.
 */
export function syncMkdir(path: string, recursive = false): void {
    const response = syncFileOperation({ type: 'mkdir', path, recursive });
    if (!response.success) {
        throw new Error(response.error || `Failed to mkdir: ${path}`);
    }
}

/**
 * Synchronously remove a directory.
 */
export function syncRmdir(path: string, recursive = false): void {
    const response = syncFileOperation({ type: 'rmdir', path, recursive });
    if (!response.success) {
        throw new Error(response.error || `Failed to rmdir: ${path}`);
    }
}

/**
 * Synchronously remove a file.
 */
export function syncUnlink(path: string): void {
    const response = syncFileOperation({ type: 'unlink', path });
    if (!response.success) {
        throw new Error(response.error || `Failed to unlink: ${path}`);
    }
}

// ============================================================
// HELPERS
// ============================================================

const timeZero = {
    seconds: BigInt(0),
    nanoseconds: 0,
};

/**
 * Convert Unix timestamp in milliseconds to WASI datetime format
 */
export function msToDatetime(ms: number | undefined): { seconds: bigint; nanoseconds: number } {
    if (!ms) return timeZero;
    const seconds = BigInt(Math.floor(ms / 1000));
    const nanoseconds = (ms % 1000) * 1_000_000;
    return { seconds, nanoseconds };
}
