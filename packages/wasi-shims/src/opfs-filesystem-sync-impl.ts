/**
 * OPFS Filesystem Sync Implementation
 * 
 * This module provides SYNCHRONOUS filesystem methods for use with jco sync mode.
 * It communicates with the opfs-async-helper worker via SharedArrayBuffer + Atomics.wait
 * to perform OPFS operations without using async/await.
 * 
 * This is required for Safari support since:
 * 1. Safari doesn't support JSPI
 * 2. jco's sync mode requires ALL imported methods to be synchronous
 * 3. Regular OPFS APIs are async, so we use a helper worker that can be blocked on
 * 
 * The JSPI version (opfs-filesystem-impl.ts) should be used for Chrome/Firefox where
 * JSPI can properly suspend the WASM stack for async operations.
 */

import { msToDatetime } from './opfs-sync-bridge';
import { InputStream, OutputStream } from './streams';

// Control array layout - must match opfs-async-helper.ts
const CONTROL = {
    REQUEST_READY: 0,
    RESPONSE_READY: 1,
    DATA_LENGTH: 2,
    SHUTDOWN: 3,
};

interface OPFSRequest {
    type: 'scanDirectory' | 'readFile' | 'writeFile' | 'readFileBinary' | 'writeFileBinary' | 'exists' | 'stat' | 'mkdir' | 'rmdir' | 'unlink';
    path: string;
    data?: string;
    recursive?: boolean;
    binaryOffset?: number;
    binaryLength?: number;
}

interface OPFSResponse {
    success: boolean;
    entries?: Array<{ name: string; kind: 'file' | 'directory'; size?: number; mtime?: number }>;
    data?: string;
    size?: number;
    mtime?: number;
    isFile?: boolean;
    isDirectory?: boolean;
    error?: string;
    binaryOffset?: number;
    binaryLength?: number;
}

interface TreeEntry {
    dir?: Record<string, TreeEntry>;
    size?: number;
    mtime?: number;
    symlink?: string;
}

// Shared state with helper worker
let controlArray: Int32Array | null = null;
let dataArray: Uint8Array | null = null;
let helperWorker: Worker | null = null;
let initialized = false;

// Tree index (cached for performance)
let treeIndex: TreeEntry = { dir: {} };
let currentDirectory = '';

/**
 * Initialize the sync filesystem with the helper worker
 */
export function initFilesystemSync(sharedBuffer: SharedArrayBuffer): Promise<void> {
    if (initialized) return Promise.resolve();

    return new Promise((resolve, reject) => {
        // Create control and data views
        controlArray = new Int32Array(sharedBuffer, 0, 16);
        dataArray = new Uint8Array(sharedBuffer, 64);

        // Reset control flags
        Atomics.store(controlArray, CONTROL.REQUEST_READY, 0);
        Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);
        Atomics.store(controlArray, CONTROL.SHUTDOWN, 0);

        // Create helper worker
        helperWorker = new Worker(
            new URL('./opfs-async-helper.js', import.meta.url),
            { type: 'module' }
        );

        helperWorker.onmessage = (e) => {
            if (e.data.type === 'ready') {
                console.log('[opfs-sync] Helper worker ready');

                // Build initial tree index by scanning root
                try {
                    buildTreeIndex();
                    initialized = true;
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        };

        helperWorker.onerror = (e) => {
            console.error('[opfs-sync] Helper worker error:', e);
            reject(e);
        };

        // Initialize helper with shared buffer
        helperWorker.postMessage({ type: 'init', buffer: sharedBuffer });
    });
}

/**
 * Make a synchronous request to the helper worker
 * This BLOCKS the calling thread via Atomics.wait until response is ready
 */
function makeRequest(request: OPFSRequest): OPFSResponse {
    if (!controlArray || !dataArray) {
        throw new Error('[opfs-sync] Filesystem not initialized');
    }

    // Encode and send request
    const requestJson = JSON.stringify(request);
    const requestBytes = new TextEncoder().encode(requestJson);

    if (requestBytes.length > dataArray.length) {
        throw new Error('[opfs-sync] Request too large');
    }

    dataArray.set(requestBytes);
    Atomics.store(controlArray, CONTROL.DATA_LENGTH, requestBytes.length);

    // Signal request ready
    Atomics.store(controlArray, CONTROL.RESPONSE_READY, 0);
    Atomics.store(controlArray, CONTROL.REQUEST_READY, 1);
    Atomics.notify(controlArray, CONTROL.REQUEST_READY);

    // BLOCK until response is ready
    const waitResult = Atomics.wait(controlArray, CONTROL.RESPONSE_READY, 0, 30000);
    if (waitResult === 'timed-out') {
        throw new Error('[opfs-sync] Request timed out');
    }

    // Read response
    const responseLength = Atomics.load(controlArray, CONTROL.DATA_LENGTH);
    const responseJson = new TextDecoder().decode(dataArray.slice(0, responseLength));

    try {
        return JSON.parse(responseJson);
    } catch (_e) {
        throw new Error(`[opfs-sync] Failed to parse response: ${responseJson}`);
    }
}

/**
 * Build the tree index by recursively scanning directories
 */
function buildTreeIndex(): void {
    console.log('[opfs-sync] Building tree index...');
    treeIndex = { dir: {} };
    scanDirectoryIntoTree('', treeIndex.dir!);
    console.log('[opfs-sync] Tree index built');
}

function scanDirectoryIntoTree(path: string, parent: Record<string, TreeEntry>): void {
    const response = makeRequest({ type: 'scanDirectory', path });

    if (!response.success || !response.entries) {
        return;
    }

    for (const entry of response.entries) {
        const fullPath = path ? `${path}/${entry.name}` : entry.name;

        if (entry.kind === 'directory') {
            const dir: Record<string, TreeEntry> = {};
            parent[entry.name] = { dir };
            // Recursively scan subdirectories
            scanDirectoryIntoTree(fullPath, dir);
        } else {
            parent[entry.name] = {
                size: entry.size || 0,
                mtime: entry.mtime || Date.now()
            };
        }
    }
}

function getTreeEntry(path: string): TreeEntry | undefined {
    if (!path || path === '/' || path === '.') return treeIndex;

    const parts = path.split('/').filter(p => p && p !== '.');
    let current = treeIndex;

    for (const part of parts) {
        if (!current.dir) return undefined;
        const next = current.dir[part];
        if (!next) return undefined;
        current = next;
    }

    return current;
}

function setTreeEntry(path: string, entry: TreeEntry): void {
    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.length === 0) return;

    let current = treeIndex;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!current.dir) current.dir = {};
        if (!current.dir[parts[i]]) {
            current.dir[parts[i]] = { dir: {} };
        }
        current = current.dir[parts[i]];
    }

    if (!current.dir) current.dir = {};
    current.dir[parts[parts.length - 1]] = entry;
}

function removeTreeEntry(path: string): void {
    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.length === 0) return;

    let current = treeIndex;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!current.dir) return;
        const next = current.dir[parts[i]];
        if (!next) return;
        current = next;
    }

    if (current.dir) {
        delete current.dir[parts[parts.length - 1]];
    }
}

function normalizePath(path: string): string {
    return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
}

function resolvePath(base: string, subpath: string): string {
    if (subpath.startsWith('/')) return normalizePath(subpath);
    if (!base || base === '/' || base === '.') return normalizePath(subpath);
    return normalizePath(`${base}/${subpath}`);
}

// ============================================================
// WASI CLASSES (Sync versions)
// ============================================================

/**
 * IMPORTANT: Singleton Pattern for JCO Resource Validation
 * 
 * JCO-generated trampolines use `instanceof` checks to validate WASI resources.
 * When modules are loaded multiple times (e.g., by different bundler entry points),
 * each module instance gets its own class constructor, causing instanceof to fail.
 * 
 * We use Symbol.for() to create global singleton class references that persist
 * across all module loads. This ensures all code references the same class prototype.
 * 
 * FUTURE: Consider implementing a full shared module registry pattern.
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/for
 */

// DirectoryEntryStream - sync version
class _DirectoryEntryStreamSync {
    private idx = 0;
    private entries: Array<[string, TreeEntry]>;

    constructor(entries: Array<[string, TreeEntry]>) {
        this.entries = entries;
    }

    readDirectoryEntry(): { name: string; type: string } | null {
        if (this.idx >= this.entries.length) return null;
        const [name, entry] = this.entries[this.idx++];
        const type = entry.dir !== undefined ? 'directory' : 'regular-file';
        return { name, type };
    }
}

// Singleton registration via Symbol.for
const DIRECTORY_ENTRY_STREAM_SYNC_KEY = Symbol.for('wasi:DirectoryEntryStream:sync');
if (!(globalThis as Record<symbol, unknown>)[DIRECTORY_ENTRY_STREAM_SYNC_KEY]) {
    (globalThis as Record<symbol, unknown>)[DIRECTORY_ENTRY_STREAM_SYNC_KEY] = _DirectoryEntryStreamSync;
}
const DirectoryEntryStream = (globalThis as Record<symbol, unknown>)[DIRECTORY_ENTRY_STREAM_SYNC_KEY] as typeof _DirectoryEntryStreamSync;
type DirectoryEntryStream = InstanceType<typeof DirectoryEntryStream>;

// Descriptor - sync version
class _DescriptorSync {
    private path: string;
    private treeEntry: TreeEntry;
    private isRoot: boolean;

    constructor(path: string, entry: TreeEntry) {
        this.path = path;
        this.treeEntry = entry;
        this.isRoot = path === '' || path === '/';
    }

    getType(): string {
        if (this.treeEntry.dir !== undefined) return 'directory';
        return 'regular-file';
    }

    // SYNC: stat on self
    stat() {
        let type = 'unknown';
        let size = BigInt(0);

        if (this.treeEntry.dir !== undefined) {
            type = 'directory';
        } else {
            type = 'regular-file';
            size = BigInt(this.treeEntry.size || 0);
        }

        const mtime = msToDatetime(this.treeEntry.mtime);

        const returnVal = {
            type,
            linkCount: BigInt(0),
            size,
            dataAccessTimestamp: mtime,
            dataModificationTimestamp: mtime,
            statusChangeTimestamp: mtime,
        };

        return returnVal;
    }

    // SYNC: stat at subpath
    statAt(_pathFlags: number, subpath: string) {
        const fullPath = resolvePath(this.path, subpath);
        const entry = getTreeEntry(fullPath);

        if (!entry) throw 'no-entry';

        let type = 'unknown';
        let size = BigInt(0);

        if (entry.dir !== undefined) {
            type = 'directory';
        } else {
            type = 'regular-file';
            // For files, get fresh stat from OPFS
            const response = makeRequest({ type: 'stat', path: fullPath });
            if (response.success && response.size !== undefined) {
                size = BigInt(response.size);
            } else {
                size = BigInt(entry.size || 0);
            }
        }

        const mtime = msToDatetime(entry.mtime);

        return {
            type,
            linkCount: BigInt(0),
            size,
            dataAccessTimestamp: mtime,
            dataModificationTimestamp: mtime,
            statusChangeTimestamp: mtime,
        };
    }

    // SYNC: open file or directory at subpath
    openAt(
        _pathFlags: number,
        subpath: string,
        openFlags: { create?: boolean; directory?: boolean; truncate?: boolean },
        _descriptorFlags: number,
        _modes: number
    ): Descriptor {
        const fullPath = resolvePath(this.path, subpath);
        let entry = getTreeEntry(fullPath);

        if (!entry && openFlags.create) {
            // Create new entry
            if (openFlags.directory) {
                const response = makeRequest({ type: 'mkdir', path: fullPath, recursive: true });
                if (!response.success) throw response.error || 'cannot-create';
                entry = { dir: {} };
            } else {
                // Create empty file
                const response = makeRequest({ type: 'writeFileBinary', path: fullPath, binaryOffset: 1024, binaryLength: 0 });
                if (!response.success) throw response.error || 'cannot-create';
                entry = { size: 0, mtime: Date.now() };
            }
            setTreeEntry(fullPath, entry);
        }

        if (!entry) throw 'no-entry';

        if (openFlags.truncate && !entry.dir) {
            // Truncate file
            const response = makeRequest({ type: 'writeFileBinary', path: fullPath, binaryOffset: 1024, binaryLength: 0 });
            if (!response.success) throw response.error || 'cannot-truncate';
            entry.size = 0;
        }

        return new Descriptor(fullPath, entry);
    }

    // SYNC: create directory
    createDirectoryAt(subpath: string): void {
        const fullPath = resolvePath(this.path, subpath);
        // Check if directory already exists in tree - don't overwrite!
        const existing = getTreeEntry(fullPath);
        if (existing?.dir !== undefined) {
            // Directory already exists, nothing to do
            return;
        }
        const response = makeRequest({ type: 'mkdir', path: fullPath, recursive: true });
        if (!response.success) throw response.error || 'cannot-create';
        // Only create new empty dir entry if it doesn't exist
        if (!existing) {
            setTreeEntry(fullPath, { dir: {} });
        }
    }

    // SYNC: read file content
    read(length: bigint | number, offset: bigint): [Uint8Array, boolean] {
        if (!controlArray || !dataArray) throw 'io';

        const response = makeRequest({ type: 'readFileBinary', path: this.path });
        if (!response.success) throw 'io';

        const binaryOffset = response.binaryOffset || 1024;
        const binaryLength = response.binaryLength || 0;

        const off = Number(offset);
        const len = Number(length);
        const actualStart = Math.min(off, binaryLength);
        const actualEnd = Math.min(off + len, binaryLength);
        const actualLen = actualEnd - actualStart;

        if (actualLen <= 0) return [new Uint8Array(0), true];

        const result = dataArray.slice(binaryOffset + actualStart, binaryOffset + actualEnd);
        const eof = actualEnd >= binaryLength;

        return [result, eof];
    }

    // SYNC: read via stream
    readViaStream(_offset: bigint): unknown {
        if (!controlArray || !dataArray) throw 'io';

        const response = makeRequest({ type: 'readFileBinary', path: this.path });
        if (!response.success) throw 'io';

        const binaryOffset = response.binaryOffset || 1024;
        const binaryLength = response.binaryLength || 0;
        const content = dataArray.slice(binaryOffset, binaryOffset + binaryLength);

        let position = Number(_offset);

        const doRead = (len: bigint): Uint8Array => {
            const toRead = Math.min(Number(len), content.length - position);
            if (toRead <= 0) return new Uint8Array(0);
            const result = content.slice(position, position + toRead);
            position += toRead;
            return result;
        };

        // Return proper InputStream instance (required by WASI)
        return new InputStream({
            read: doRead,
            blockingRead: doRead,
        });
    }

    // SYNC: write file content
    write(buffer: Uint8Array, offset: bigint): number {
        if (!controlArray || !dataArray) throw 'io';

        // Read existing content if offset > 0
        let existingContent = new Uint8Array(0);
        const off = Number(offset);

        if (off > 0) {
            const readResp = makeRequest({ type: 'readFileBinary', path: this.path });
            if (readResp.success && readResp.binaryLength) {
                existingContent = dataArray.slice(
                    readResp.binaryOffset || 1024,
                    (readResp.binaryOffset || 1024) + readResp.binaryLength
                );
            }
        }

        // Merge existing with new content
        const newLength = Math.max(off + buffer.length, existingContent.length);
        const merged = new Uint8Array(newLength);
        merged.set(existingContent);
        merged.set(buffer, off);

        // Write merged content
        const binaryOffset = 1024;
        dataArray.set(merged, binaryOffset);

        const response = makeRequest({
            type: 'writeFileBinary',
            path: this.path,
            binaryOffset,
            binaryLength: merged.length
        });

        if (!response.success) throw 'io';

        // Update tree
        this.treeEntry.size = merged.length;
        this.treeEntry.mtime = Date.now();

        return buffer.length;
    }

    // SYNC: write via stream
    writeViaStream(_offset: bigint): unknown {
        const path = this.path;
        const entry = this.treeEntry;
        let buffer = new Uint8Array(0);

        const doFlush = () => {
            if (!dataArray) throw 'io';
            const binaryOffset = 1024;
            dataArray.set(buffer, binaryOffset);
            const response = makeRequest({
                type: 'writeFileBinary',
                path,
                binaryOffset,
                binaryLength: buffer.length
            });
            if (response.success) {
                entry.size = buffer.length;
                entry.mtime = Date.now();
            }
        };

        const doWrite = (buf: Uint8Array): bigint => {
            const newBuf = new Uint8Array(buffer.length + buf.length);
            newBuf.set(buffer);
            newBuf.set(buf, buffer.length);
            buffer = newBuf;
            // Auto-flush on every write since Rust doesn't call flush before close
            doFlush();
            return BigInt(buf.length);
        };

        // Return proper OutputStream instance (required by WASI)
        return new OutputStream({
            write: doWrite,
            blockingWriteAndFlush(buf: Uint8Array): void {
                doWrite(buf);
                // doFlush already called by doWrite
            },
            flush: doFlush,
            blockingFlush: doFlush,
            checkWrite(): bigint {
                return BigInt(1024 * 1024);
            }
        });
    }

    // SYNC: read directory
    readDirectory(): DirectoryEntryStream {
        if (!this.treeEntry.dir) throw 'not-directory';
        const entries = Object.entries(this.treeEntry.dir);
        return new DirectoryEntryStream(entries);
    }

    // SYNC: rename
    renameAt(oldPath: string, newDescriptor: Descriptor, newPath: string): void {
        const oldFullPath = resolvePath(this.path, oldPath);
        const newFullPath = resolvePath(newDescriptor.path, newPath);

        // Read old file
        if (!dataArray) throw 'io';
        const readResp = makeRequest({ type: 'readFileBinary', path: oldFullPath });
        if (!readResp.success) throw 'no-entry';

        // Write to new location
        const writeResp = makeRequest({
            type: 'writeFileBinary',
            path: newFullPath,
            binaryOffset: readResp.binaryOffset || 1024,
            binaryLength: readResp.binaryLength || 0
        });
        if (!writeResp.success) throw 'io';

        // Delete old file
        makeRequest({ type: 'unlink', path: oldFullPath });

        // Update tree
        const entry = getTreeEntry(oldFullPath);
        if (entry) {
            removeTreeEntry(oldFullPath);
            setTreeEntry(newFullPath, entry);
        }
    }

    // SYNC: remove file
    unlinkFileAt(subpath: string): void {
        const fullPath = resolvePath(this.path, subpath);
        const response = makeRequest({ type: 'unlink', path: fullPath });
        if (!response.success) throw response.error || 'no-entry';
        removeTreeEntry(fullPath);
    }

    // SYNC: remove directory
    removeDirectoryAt(subpath: string): void {
        const fullPath = resolvePath(this.path, subpath);
        const response = makeRequest({ type: 'rmdir', path: fullPath, recursive: true });
        if (!response.success) throw response.error || 'no-entry';
        removeTreeEntry(fullPath);
    }

    // SYNC: symlink (store in tree only)
    symlinkAt(oldPath: string, newPath: string): void {
        const fullNewPath = resolvePath(this.path, newPath);
        setTreeEntry(fullNewPath, { symlink: oldPath });
    }

    isSameObject(other: Descriptor): boolean {
        return this.path === other.path;
    }

    metadataHash() {
        return { upper: BigInt(0), lower: BigInt(0) };
    }

    metadataHashAt(_flags: number, _path: string) {
        return { upper: BigInt(0), lower: BigInt(0) };
    }
}

// Singleton registration via Symbol.for
const DESCRIPTOR_SYNC_KEY = Symbol.for('wasi:Descriptor:sync');
if (!(globalThis as Record<symbol, unknown>)[DESCRIPTOR_SYNC_KEY]) {
    (globalThis as Record<symbol, unknown>)[DESCRIPTOR_SYNC_KEY] = _DescriptorSync;
}
const Descriptor = (globalThis as Record<symbol, unknown>)[DESCRIPTOR_SYNC_KEY] as typeof _DescriptorSync;
type Descriptor = InstanceType<typeof Descriptor>;

export function filesystemErrorCode(_error: unknown): string | undefined {
    return undefined;
}

// Root descriptor singleton
const rootDescriptor = new Descriptor('', { dir: {} });

export const preopens = {
    getDirectories(): [Descriptor, string][] {
        return [[rootDescriptor, '/']];
    }
};

export const types = {
    Descriptor,
    DirectoryEntryStream,
    filesystemErrorCode,
};

export { types as filesystemTypes };

export function _setCwd(path: string) {
    currentDirectory = normalizePath(path);
}

export function _getCwd(): string {
    return currentDirectory || '/';
}

// Auto-initialize when first imported in a worker context
let initPromise: Promise<void> | null = null;

export function initFilesystem(): Promise<void> {
    if (initPromise) return initPromise;

    // Create shared buffer for communication
    const bufferSize = 64 + 64 * 1024; // 64 bytes control + 64KB data
    const sharedBuffer = new SharedArrayBuffer(bufferSize);

    initPromise = initFilesystemSync(sharedBuffer);
    return initPromise;
}

// ============================================================
// Sync Git Filesystem Adapter
// Provides sync fs.promises-like interface for isomorphic-git
// ============================================================

function normalizeSyncPath(filepath: string): string {
    // Remove leading slash for internal operations, but keep for root
    const normalized = filepath.replace(/\/+/g, '/');
    return normalized.startsWith('/') ? normalized.slice(1) : normalized;
}

function createFsError(code: string, message: string): Error {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
}

function hashPathForIno(path: string): number {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
        hash = ((hash << 5) - hash) + path.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

interface GitStats {
    type: 'file' | 'dir' | 'symlink';
    mode: number;
    size: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

function createGitStats(isDir: boolean, size: number, mtime: number, path: string): GitStats {
    return {
        type: isDir ? 'dir' : 'file',
        mode: isDir ? 0o40755 : 0o100644,
        size,
        ino: hashPathForIno(path),
        mtimeMs: mtime,
        ctimeMs: mtime,
        uid: 1000,
        gid: 1000,
        dev: 1,
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
    };
}

/**
 * Synchronous filesystem adapter for isomorphic-git
 * Uses the sync OPFS shim to perform blocking file operations
 * 
 * Note: Even though the interface uses Promise, the operations complete
 * synchronously via Atomics.wait, so they resolve immediately.
 */
export const syncGitFs = {
    promises: {
        readFile(
            filepath: string,
            options?: { encoding?: string } | string
        ): Promise<Uint8Array | string> {
            const path = normalizeSyncPath(filepath);

            if (!path || path === '' || path === '/') {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`));
            }

            try {
                const response = makeRequest({ type: 'readFileBinary', path });
                if (!response.success) {
                    throw createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`);
                }

                const binaryOffset = response.binaryOffset || 1024;
                const binaryLength = response.binaryLength || 0;
                const data = dataArray!.slice(binaryOffset, binaryOffset + binaryLength);

                const encoding = typeof options === 'string' ? options : options?.encoding;
                if (encoding === 'utf8' || encoding === 'utf-8') {
                    return Promise.resolve(new TextDecoder().decode(data));
                }
                return Promise.resolve(new Uint8Array(data));
            } catch (e) {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`));
            }
        },

        writeFile(
            filepath: string,
            data: Uint8Array | string,
            _options?: { encoding?: string; mode?: number }
        ): Promise<void> {
            const path = normalizeSyncPath(filepath);
            if (!path) {
                return Promise.reject(createFsError('EINVAL', 'Cannot write to root'));
            }

            try {
                const bytes = typeof data === 'string'
                    ? new TextEncoder().encode(data)
                    : data;

                // Ensure parent directories exist
                const parts = path.split('/').filter(p => p);
                if (parts.length > 1) {
                    const parentPath = parts.slice(0, -1).join('/');
                    makeRequest({ type: 'mkdir', path: parentPath, recursive: true });
                    // Also add to tree
                    setTreeEntry(parentPath, { dir: {} });
                }

                // Write the file
                const binaryOffset = 1024;
                dataArray!.set(bytes, binaryOffset);
                const response = makeRequest({
                    type: 'writeFileBinary',
                    path,
                    binaryOffset,
                    binaryLength: bytes.length
                });

                if (!response.success) {
                    throw new Error(response.error || 'Write failed');
                }

                // Update tree
                setTreeEntry(path, { size: bytes.length, mtime: Date.now() });
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(createFsError('EIO', `Failed to write '${filepath}': ${e}`));
            }
        },

        unlink(filepath: string): Promise<void> {
            const path = normalizeSyncPath(filepath);
            if (!path) {
                return Promise.reject(createFsError('EINVAL', 'Cannot unlink root'));
            }

            try {
                const response = makeRequest({ type: 'unlink', path });
                if (!response.success) {
                    throw new Error(response.error);
                }
                // Remove from tree
                removeTreeEntry(path);
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, unlink '${filepath}'`));
            }
        },

        readdir(dirpath: string): Promise<string[]> {
            const path = normalizeSyncPath(dirpath);

            try {
                // Use tree for fast lookup if available
                const entry = getTreeEntry(path || '/');
                if (entry?.dir) {
                    return Promise.resolve(Object.keys(entry.dir));
                }

                // Fallback to direct OPFS scan
                const response = makeRequest({ type: 'scanDirectory', path: path || '' });
                if (!response.success || !response.entries) {
                    throw new Error(response.error);
                }
                return Promise.resolve(response.entries.map(e => e.name));
            } catch {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, scandir '${dirpath}'`));
            }
        },

        mkdir(dirpath: string, _options?: { recursive?: boolean }): Promise<void> {
            const path = normalizeSyncPath(dirpath);
            if (!path) return Promise.resolve(); // Don't create root

            try {
                // Check if already exists
                const existing = getTreeEntry(path);
                if (existing?.dir !== undefined) {
                    return Promise.resolve();
                }

                const response = makeRequest({ type: 'mkdir', path, recursive: true });
                if (!response.success) {
                    throw new Error(response.error);
                }
                // Add to tree
                setTreeEntry(path, { dir: {} });
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(createFsError('ENOENT', `Failed to create directory '${dirpath}'`));
            }
        },

        rmdir(dirpath: string): Promise<void> {
            const path = normalizeSyncPath(dirpath);
            if (!path) {
                return Promise.reject(createFsError('EINVAL', 'Cannot rmdir root'));
            }

            try {
                const response = makeRequest({ type: 'rmdir', path });
                if (!response.success) {
                    throw new Error(response.error);
                }
                removeTreeEntry(path);
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such directory, rmdir '${dirpath}'`));
            }
        },

        stat(filepath: string): Promise<GitStats> {
            const path = normalizeSyncPath(filepath);

            // Handle root
            if (!path || path === '/') {
                return Promise.resolve(createGitStats(true, 0, Date.now(), '/'));
            }

            try {
                // Try tree first
                const entry = getTreeEntry(path);
                if (entry) {
                    const isDir = entry.dir !== undefined;
                    return Promise.resolve(createGitStats(isDir, entry.size || 0, entry.mtime || Date.now(), path));
                }

                // Fallback to OPFS stat
                const response = makeRequest({ type: 'stat', path });
                if (!response.success) {
                    throw new Error(response.error);
                }
                const isDir = response.isDirectory || false;
                return Promise.resolve(createGitStats(isDir, response.size || 0, response.mtime || Date.now(), path));
            } catch {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, stat '${filepath}'`));
            }
        },

        lstat(filepath: string): Promise<GitStats> {
            // Same as stat (no symlinks in OPFS)
            return this.stat(filepath);
        },

        readlink(_filepath: string): Promise<string> {
            return Promise.reject(createFsError('EINVAL', 'Symlinks not supported in OPFS'));
        },

        symlink(_target: string, _filepath: string): Promise<void> {
            // Silently ignore for git compatibility
            return Promise.resolve();
        },

        chmod(_filepath: string, _mode: number): Promise<void> {
            // No-op: OPFS doesn't support Unix permissions
            return Promise.resolve();
        },

        rename(oldPath: string, newPath: string): Promise<void> {
            const oldNorm = normalizeSyncPath(oldPath);
            const newNorm = normalizeSyncPath(newPath);

            if (!oldNorm || !newNorm) {
                return Promise.reject(createFsError('EINVAL', 'Invalid path for rename'));
            }

            try {
                // Read old file
                const readResp = makeRequest({ type: 'readFileBinary', path: oldNorm });
                if (!readResp.success) {
                    throw new Error('Source file not found');
                }

                const binaryOffset = readResp.binaryOffset || 1024;
                const binaryLength = readResp.binaryLength || 0;
                const data = dataArray!.slice(binaryOffset, binaryOffset + binaryLength);

                // Write to new location
                dataArray!.set(data, 1024);
                const writeResp = makeRequest({
                    type: 'writeFileBinary',
                    path: newNorm,
                    binaryOffset: 1024,
                    binaryLength: data.length
                });
                if (!writeResp.success) {
                    throw new Error('Write failed');
                }

                // Delete old file
                makeRequest({ type: 'unlink', path: oldNorm });

                // Update tree
                const entry = getTreeEntry(oldNorm);
                if (entry) {
                    setTreeEntry(newNorm, entry);
                    removeTreeEntry(oldNorm);
                }

                return Promise.resolve();
            } catch (e) {
                return Promise.reject(createFsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}'`));
            }
        },
    },
};
