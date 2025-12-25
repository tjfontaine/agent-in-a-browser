/**
 * Directory Tree Management
 * 
 * In-memory directory tree for WASI filesystem.
 * File content is persisted via OPFS, tree is loaded on startup.
 */

import {
    isHelperReady,
    getControlArray,
    getDataArray,
    type OPFSRequest,
    type OPFSResponse,
} from './opfs-sync-bridge';

// ============================================================
// TYPES
// ============================================================

export interface TreeEntry {
    dir?: Record<string, TreeEntry>;
    size?: number;
    mtime?: number; // Unix timestamp in milliseconds
    _scanned?: boolean; // Has this directory been scanned from OPFS?
}

// ============================================================
// STATE
// ============================================================

export const directoryTree: TreeEntry = { dir: {}, _scanned: false };
let opfsRoot: FileSystemDirectoryHandle | null = null;
let initialized = false;

// Current working directory
let cwd = '/';

// Cache of open SyncAccessHandles for files
export const syncHandleCache = new Map<string, FileSystemSyncAccessHandle>();

// Control array layout (matches opfs-async-helper.ts)
const CONTROL = {
    REQUEST_READY: 0,
    RESPONSE_READY: 1,
    DATA_LENGTH: 2,
    SHUTDOWN: 3,
};

// ============================================================
// CWD MANAGEMENT
// ============================================================

export function setCwd(path: string): void {
    cwd = path;
}

export function getCwd(): string {
    return cwd;
}

// ============================================================
// INITIALIZATION
// ============================================================

export function isInitialized(): boolean {
    return initialized;
}

export function setInitialized(value: boolean): void {
    initialized = value;
}

export function getOpfsRoot(): FileSystemDirectoryHandle | null {
    return opfsRoot;
}

export function setOpfsRoot(root: FileSystemDirectoryHandle): void {
    opfsRoot = root;
}

// ============================================================
// SYNC DIRECTORY SCAN
// ============================================================

/**
 * Synchronously scan a directory via the async helper worker.
 * Uses Atomics.wait() to block until the helper completes.
 */
export function syncScanDirectory(path: string): boolean {
    const controlArray = getControlArray();
    const dataArray = getDataArray();

    if (!controlArray || !dataArray || !isHelperReady()) {
        console.warn('[opfs-fs] Helper not ready, falling back to empty directory');
        return false;
    }

    // Prepare request
    const request: OPFSRequest = { type: 'scanDirectory', path };
    const requestBytes = new TextEncoder().encode(JSON.stringify(request));

    // Write request to shared buffer
    dataArray.set(requestBytes);
    Atomics.store(controlArray, CONTROL.DATA_LENGTH, requestBytes.length);

    // Reset response flag before signaling request
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);

    // Signal request ready and wake up helper
    Atomics.store(controlArray, CONTROL.REQUEST_READY, 1);
    Atomics.notify(controlArray, CONTROL.REQUEST_READY);

    console.log('[opfs-fs] Waiting for helper to scan:', path);

    // Wait for response - THIS BLOCKS SYNCHRONOUSLY
    const waitResult = Atomics.wait(controlArray, CONTROL.RESPONSE_READY, 0, 30000); // 30s timeout

    if (waitResult === 'timed-out') {
        console.error('[opfs-fs] Timeout waiting for helper response');
        return false;
    }

    // Read response
    const responseLength = Atomics.load(controlArray, CONTROL.DATA_LENGTH);
    const responseJson = new TextDecoder().decode(dataArray.slice(0, responseLength));

    // Reset response flag
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);

    let response: OPFSResponse;
    try {
        response = JSON.parse(responseJson);
    } catch (_e) {
        console.error('[opfs-fs] Failed to parse response:', responseJson);
        return false;
    }

    if (!response.success || !response.entries) {
        console.warn('[opfs-fs] Helper scan failed:', response.error);
        return false;
    }

    // Update tree with scan results
    const entry = path === '' || path === '/' ? directoryTree : getTreeEntry(path);
    if (entry && entry.dir !== undefined) {
        for (const item of response.entries) {
            if (item.kind === 'directory') {
                if (!entry.dir[item.name]) {
                    entry.dir[item.name] = { dir: {}, _scanned: false };
                }
            } else {
                entry.dir[item.name] = { size: item.size, mtime: item.mtime };
            }
        }
        entry._scanned = true;
        console.log('[opfs-fs] Scanned', path || '/', 'with', response.entries.length, 'entries');
    }

    return true;
}

// ============================================================
// PATH UTILITIES
// ============================================================

export function normalizePath(path: string): string {
    if (!path || path === '/' || path === '.') return '';
    return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

// ============================================================
// TREE NAVIGATION
// ============================================================

export function getTreeEntry(path: string): TreeEntry | undefined {
    const parts = normalizePath(path).split('/').filter(p => p);
    let current = directoryTree;

    for (const part of parts) {
        if (!current.dir || !current.dir[part]) {
            return undefined;
        }
        current = current.dir[part];
    }
    return current;
}

export function setTreeEntry(path: string, entry: TreeEntry): void {
    const parts = normalizePath(path).split('/').filter(p => p);
    if (parts.length === 0) return;

    const name = parts.pop()!;
    let current = directoryTree;

    for (const part of parts) {
        if (!current.dir) current.dir = {};
        if (!current.dir[part]) current.dir[part] = { dir: {} };
        current = current.dir[part];
    }

    if (!current.dir) current.dir = {};
    current.dir[name] = entry;
}

export function removeTreeEntry(path: string): void {
    const parts = normalizePath(path).split('/').filter(p => p);
    if (parts.length === 0) return;

    const name = parts.pop()!;
    let current = directoryTree;

    for (const part of parts) {
        if (!current.dir || !current.dir[part]) {
            return; // Parent doesn't exist
        }
        current = current.dir[part];
    }

    if (current.dir && current.dir[name]) {
        delete current.dir[name];
    }
}

// ============================================================
// OPFS HANDLE MANAGEMENT
// ============================================================

/**
 * Get or create OPFS directory handle for a path
 */
export async function getOpfsDirectory(pathParts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw 'no-entry';

    let current = opfsRoot;
    for (const part of pathParts) {
        try {
            current = await current.getDirectoryHandle(part, { create });
        } catch {
            throw 'no-entry';
        }
    }
    return current;
}

/**
 * Get OPFS file handle for a path
 */
export async function getOpfsFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw 'no-entry';

    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.length === 0) throw 'no-entry';

    const fileName = parts.pop()!;
    const dir = parts.length > 0
        ? await getOpfsDirectory(parts, create)
        : opfsRoot;

    try {
        return await dir.getFileHandle(fileName, { create });
    } catch {
        throw 'no-entry';
    }
}

/**
 * Close all open sync handles (call on shutdown)
 */
export function closeAllHandles(): void {
    for (const [path, handle] of syncHandleCache) {
        try {
            handle.close();
        } catch (e) {
            console.warn('[opfs-fs] Failed to close handle:', path, e);
        }
    }
    syncHandleCache.clear();
}

/**
 * Close all sync handles that are under a path prefix.
 * Used before removing a directory to release file locks.
 */
export function closeHandlesUnderPath(pathPrefix: string): void {
    const prefix = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
    const toRemove: string[] = [];

    for (const [cachedPath, handle] of syncHandleCache) {
        // Check if this path is under the prefix
        if (cachedPath.startsWith(prefix) || cachedPath === pathPrefix) {
            try {
                handle.close();
                console.log('[opfs-fs] Closed handle for:', cachedPath);
            } catch (e) {
                console.warn('[opfs-fs] Failed to close handle:', cachedPath, e);
            }
            toRemove.push(cachedPath);
        }
    }

    for (const path of toRemove) {
        syncHandleCache.delete(path);
    }
}

// ============================================================
// WASI HELPERS
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
