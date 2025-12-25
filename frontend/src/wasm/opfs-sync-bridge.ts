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
    type: 'readFile' | 'writeFile' | 'exists' | 'stat' | 'mkdir' | 'rmdir' | 'unlink';
    path: string;
    data?: string;
    recursive?: boolean;
}

export interface SyncFileResponse {
    success: boolean;
    data?: string;
    size?: number;
    mtime?: number;
    isFile?: boolean;
    isDirectory?: boolean;
    error?: string;
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
 * Initialize the helper worker and shared memory.
 * Returns a promise that resolves when the helper is ready.
 */
export async function initHelperWorker(): Promise<void> {
    if (helperReady) return;

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
        new URL('./opfs-async-helper.ts', import.meta.url),
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
