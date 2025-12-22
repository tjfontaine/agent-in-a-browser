/**
 * OPFS-backed WASI Filesystem Implementation
 * 
 * Hybrid storage approach:
 * - File content: SyncAccessHandle for true OPFS persistence
 * - Directory tree: In-memory index (loaded on startup, updated on file ops)
 * 
 * This replaces @bytecodealliance/preview2-shim/filesystem for browser workers.
 */

import { streams } from '@bytecodealliance/preview2-shim/io';

// @ts-expect-error - preview2-shim exports this as type-only but it's a runtime value
const { InputStream, OutputStream } = streams as unknown as { InputStream: new (config: unknown) => unknown; OutputStream: new (config: unknown) => unknown };


// ============================================================
// DIRECTORY TREE (in-memory, loaded on startup)
// ============================================================

interface TreeEntry {
    dir?: Record<string, TreeEntry>;
    size?: number;
}

const directoryTree: TreeEntry = { dir: {} };
let opfsRoot: FileSystemDirectoryHandle | null = null;
let initialized = false;

// Current working directory
let cwd = '/';

export function _setCwd(path: string) {
    cwd = path;
}

export function _getCwd(): string {
    return cwd;
}

/**
 * Initialize the filesystem by scanning OPFS and building the directory tree.
 * Must be called before any filesystem operations.
 */
export async function initFilesystem(): Promise<void> {
    if (initialized) return;

    try {
        opfsRoot = await navigator.storage.getDirectory();
        console.log('[opfs-fs] Scanning OPFS for existing files...');
        await scanDirectory(opfsRoot, directoryTree);
        initialized = true;
        console.log('[opfs-fs] Filesystem initialized, tree:', JSON.stringify(directoryTree, null, 2));
    } catch (e) {
        console.error('[opfs-fs] Failed to initialize OPFS:', e);
        // Continue with empty tree
        initialized = true;
    }
}

/**
 * Recursively scan OPFS directory, populate the tree, and pre-acquire sync handles
 */
async function scanDirectory(handle: FileSystemDirectoryHandle, tree: TreeEntry, basePath: string = ''): Promise<void> {
    if (!tree.dir) tree.dir = {};

    for await (const [name, child] of (handle as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
        const fullPath = basePath ? `${basePath}/${name}` : name;

        if (child.kind === 'directory') {
            tree.dir[name] = { dir: {} };
            await scanDirectory(child as FileSystemDirectoryHandle, tree.dir[name], fullPath);
        } else {
            // Get file size and pre-acquire sync handle
            const fileHandle = child as FileSystemFileHandle;
            const file = await fileHandle.getFile();
            tree.dir[name] = { size: file.size };

            // Pre-acquire sync handle for reads
            try {
                const syncHandle = await fileHandle.createSyncAccessHandle();
                syncHandleCache.set(fullPath, syncHandle);
                console.log('[opfs-fs] Pre-acquired sync handle for:', fullPath);
            } catch (e) {
                console.warn('[opfs-fs] Failed to acquire sync handle for:', fullPath, e);
            }
        }
    }
}

// ============================================================
// OPFS HANDLE CACHE
// ============================================================

// Cache of open SyncAccessHandles for files
const syncHandleCache = new Map<string, FileSystemSyncAccessHandle>();

/**
 * Get or create OPFS directory handle for a path
 */
async function getOpfsDirectory(pathParts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
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
async function getOpfsFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
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

// ============================================================
// TREE NAVIGATION
// ============================================================

function getTreeEntry(path: string): TreeEntry | undefined {
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

function setTreeEntry(path: string, entry: TreeEntry): void {
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

function normalizePath(path: string): string {
    if (!path || path === '/' || path === '.') return '';
    return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function removeTreeEntry(path: string): void {
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
// WASI TYPES
// ============================================================

const timeZero = {
    seconds: BigInt(0),
    nanoseconds: 0,
};

class DirectoryEntryStream {
    private idx = 0;
    private entries: Array<[string, TreeEntry]>;

    constructor(entries: Array<[string, TreeEntry]>) {
        this.entries = entries;
    }

    readDirectoryEntry(): { name: string; type: string } | null {
        if (this.idx >= this.entries.length) {
            return null;
        }
        const [name, entry] = this.entries[this.idx];
        this.idx += 1;
        return {
            name,
            type: entry.dir ? 'directory' : 'regular-file',
        };
    }
}

class Descriptor {
    private path: string;
    private treeEntry: TreeEntry;
    private isRoot: boolean;

    constructor(path: string, entry: TreeEntry) {
        this.path = path;
        this.treeEntry = entry;
        this.isRoot = path === '' || path === '/';
    }

    getType(): string {
        if (this.treeEntry.dir !== undefined) {
            return 'directory';
        }
        return 'regular-file';
    }

    stat() {
        let type = 'unknown';
        let size = BigInt(0);

        if (this.treeEntry.dir !== undefined) {
            type = 'directory';
        } else if (this.treeEntry.size !== undefined) {
            type = 'regular-file';
            size = BigInt(this.treeEntry.size);
        }

        return {
            type,
            linkCount: BigInt(0),
            size,
            dataAccessTimestamp: timeZero,
            dataModificationTimestamp: timeZero,
            statusChangeTimestamp: timeZero,
        };
    }

    statAt(_pathFlags: number, subpath: string) {
        const fullPath = this.resolvePath(subpath);
        const entry = getTreeEntry(fullPath);

        if (!entry) {
            throw 'no-entry';
        }

        let type = 'unknown';
        let size = BigInt(0);

        if (entry.dir !== undefined) {
            type = 'directory';
        } else if (entry.size !== undefined) {
            type = 'regular-file';
            size = BigInt(entry.size);
        }

        return {
            type,
            linkCount: BigInt(0),
            size,
            dataAccessTimestamp: timeZero,
            dataModificationTimestamp: timeZero,
            statusChangeTimestamp: timeZero,
        };
    }

    openAt(
        _pathFlags: number,
        subpath: string,
        openFlags: { create?: boolean; directory?: boolean; truncate?: boolean },
        _descriptorFlags: number,
        _modes: number
    ): Descriptor {
        const fullPath = this.resolvePath(subpath);
        let entry = getTreeEntry(fullPath);

        if (!entry && openFlags.create) {
            // Create new entry
            entry = openFlags.directory ? { dir: {} } : { size: 0 };
            setTreeEntry(fullPath, entry);

            // Create in OPFS (async, but we'll handle sync access later)
            if (!openFlags.directory) {
                this.createOpfsFile(fullPath);
            } else {
                this.createOpfsDirectory(fullPath);
            }
        }

        if (!entry) {
            throw 'no-entry';
        }

        return new Descriptor(fullPath, entry);
    }

    private createOpfsFile(path: string): void {
        // Just create the file in OPFS - the sync handle will be prepared
        // by the bridge before any WASM write operations
        getOpfsFile(path, true).catch(e => {
            console.error('[opfs-fs] Failed to create file in OPFS:', path, e);
        });
    }

    private createOpfsDirectory(path: string): void {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) return;

        getOpfsDirectory(parts, true).catch(e => {
            console.error('[opfs-fs] Failed to create directory in OPFS:', path, e);
        });
    }

    createDirectoryAt(subpath: string): void {
        const fullPath = this.resolvePath(subpath);
        const existing = getTreeEntry(fullPath);

        if (existing) {
            throw 'exist';
        }

        setTreeEntry(fullPath, { dir: {} });
        this.createOpfsDirectory(fullPath);
    }

    /**
     * Read file content - uses SyncAccessHandle for OPFS persistence
     */
    read(length: number, _offset: bigint): [Uint8Array, boolean] {
        const offset = Number(_offset);
        const path = this.path;

        // Get cached sync handle
        const handle = syncHandleCache.get(path);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for read, path:', path);
            return [new Uint8Array(0), true];
        }

        const size = handle.getSize();
        const readLength = Math.min(length, size - offset);
        const buffer = new Uint8Array(readLength);

        handle.read(buffer, { at: offset });

        const eof = offset + readLength >= size;
        return [buffer, eof];
    }

    /**
     * Read via stream - returns proper WASI InputStream resource
     */
    readViaStream(_offset: bigint): unknown {
        const path = this.path;
        let offset = Number(_offset);

        const handle = syncHandleCache.get(path);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for readViaStream, path:', path);
            throw 'no-entry';
        }

        const size = handle.getSize();

        // Return a proper InputStream instance (required by WASI)
        return new InputStream({
            read(len: bigint): Uint8Array {
                if (offset >= size) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), size - offset);
                const buffer = new Uint8Array(readLen);
                handle.read(buffer, { at: offset });
                offset += readLen;
                return buffer;
            },
            blockingRead(len: bigint): Uint8Array {
                if (offset >= size) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), size - offset);
                const buffer = new Uint8Array(readLen);
                handle.read(buffer, { at: offset });
                offset += readLen;
                return buffer;
            },
            subscribe(): void { },
            [Symbol.dispose](): void { }
        });
    }

    /**
     * Write file content - uses SyncAccessHandle for OPFS persistence
     */
    write(buffer: Uint8Array, _offset: bigint): number {
        const offset = Number(_offset);
        const path = this.path;

        const handle = syncHandleCache.get(path);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for write, path:', path);
            return 0;
        }

        // Write to OPFS
        handle.write(buffer, { at: offset });
        handle.flush();

        // Update tree entry size
        const newSize = Math.max(this.treeEntry.size || 0, offset + buffer.byteLength);
        this.treeEntry.size = newSize;

        return buffer.byteLength;
    }

    /**
     * Write via stream - returns proper WASI OutputStream resource
     */
    writeViaStream(_offset: bigint): unknown {
        const path = this.path;
        const normalizedPath = normalizePath(path);
        let offset = Number(_offset);
        const entry = this.treeEntry;

        const handle = syncHandleCache.get(normalizedPath);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for writeViaStream, path:', normalizedPath);
            throw 'no-entry';
        }

        // Return a proper OutputStream instance (required by WASI)
        return new OutputStream({
            write(buf: Uint8Array): bigint {
                handle.write(buf, { at: offset });
                handle.flush();
                offset += buf.byteLength;
                entry.size = Math.max(entry.size || 0, offset);
                return BigInt(buf.byteLength);
            },
            blockingWriteAndFlush(buf: Uint8Array): void {
                handle.write(buf, { at: offset });
                handle.flush();
                offset += buf.byteLength;
                entry.size = Math.max(entry.size || 0, offset);
            },
            flush(): void {
                handle.flush();
            },
            blockingFlush(): void {
                handle.flush();
            },
            checkWrite(): bigint {
                return BigInt(1024 * 1024); // 1MB available
            },
            subscribe(): void { },
            [Symbol.dispose](): void { }
        });
    }

    readDirectory(): DirectoryEntryStream {
        console.log('[opfs-fs] readDirectory called, path:', this.path, 'hasDir:', !!this.treeEntry.dir);
        if (!this.treeEntry.dir) {
            throw 'bad-descriptor';
        }

        const entries = Object.entries(this.treeEntry.dir).sort(([a], [b]) => a > b ? 1 : -1);
        console.log('[opfs-fs] readDirectory returning', entries.length, 'entries:', entries.map(e => e[0]));
        return new DirectoryEntryStream(entries);
    }

    sync(): void {
        const handle = syncHandleCache.get(this.path);
        if (handle) {
            handle.flush();
        }
    }

    syncData(): void {
        this.sync();
    }

    // Path resolution helper
    private resolvePath(subpath: string): string {
        if (!subpath || subpath === '.') {
            return this.path;
        }

        // Handle CWD resolution
        if (subpath === '.' && this.isRoot) {
            const cwdPath = cwd.startsWith('/') ? cwd.slice(1) : cwd;
            return cwdPath;
        }

        const base = this.path ? this.path + '/' : '';
        return normalizePath(base + subpath);
    }

    // Additional methods

    /**
     * Append via stream - returns OutputStream positioned at end of file
     */
    appendViaStream(): unknown {
        const path = this.path;
        const normalizedPath = normalizePath(path);
        const entry = this.treeEntry;

        const handle = syncHandleCache.get(normalizedPath);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for appendViaStream, path:', normalizedPath);
            throw 'no-entry';
        }

        // Start at end of file
        let offset = handle.getSize();

        return new OutputStream({
            write(buf: Uint8Array): bigint {
                handle.write(buf, { at: offset });
                handle.flush();
                offset += buf.byteLength;
                entry.size = Math.max(entry.size || 0, offset);
                return BigInt(buf.byteLength);
            },
            blockingWriteAndFlush(buf: Uint8Array): void {
                handle.write(buf, { at: offset });
                handle.flush();
                offset += buf.byteLength;
                entry.size = Math.max(entry.size || 0, offset);
            },
            flush(): void {
                handle.flush();
            },
            blockingFlush(): void {
                handle.flush();
            },
            checkWrite(): bigint {
                return BigInt(1024 * 1024);
            },
            subscribe(): void { },
            [Symbol.dispose](): void { }
        });
    }

    advise() {
        // Advisory information for access pattern - no-op for OPFS
    }

    getFlags(): number {
        // Return default flags (read/write)
        return 0;
    }

    /**
     * Set file size (truncate or extend)
     */
    setSize(size: bigint): void {
        const path = this.path;
        const normalizedPath = normalizePath(path);
        console.log('[opfs-fs] setSize:', normalizedPath, 'to', size);

        const handle = syncHandleCache.get(normalizedPath);
        if (!handle) {
            console.warn('[opfs-fs] No sync handle for setSize, path:', normalizedPath);
            throw 'no-entry';
        }

        handle.truncate(Number(size));
        handle.flush();
        this.treeEntry.size = Number(size);
    }

    /**
     * Set file timestamps
     */
    setTimes(
        _dataAccessTimestamp?: { seconds: bigint; nanoseconds: number },
        _dataModificationTimestamp?: { seconds: bigint; nanoseconds: number }
    ): void {
        // OPFS doesn't support setting timestamps directly
        // Just acknowledge the call
        console.log('[opfs-fs] setTimes: not supported by OPFS, ignoring');
    }

    /**
     * Set timestamps for file at path
     */
    setTimesAt(
        _pathFlags: number,
        _path: string,
        _dataAccessTimestamp?: { seconds: bigint; nanoseconds: number },
        _dataModificationTimestamp?: { seconds: bigint; nanoseconds: number }
    ): void {
        // OPFS doesn't support setting timestamps
        console.log('[opfs-fs] setTimesAt: not supported by OPFS, ignoring');
    }

    /**
     * Create a hard link - not supported in OPFS
     */
    linkAt(
        _oldPathFlags: number,
        _oldPath: string,
        _newDescriptor: Descriptor,
        _newPath: string
    ): void {
        console.warn('[opfs-fs] linkAt: hard links not supported');
        throw 'not-supported';
    }

    /**
     * Read symbolic link - not supported in OPFS
     */
    readlinkAt(_path: string): string {
        console.warn('[opfs-fs] readlinkAt: symbolic links not supported');
        throw 'not-supported';
    }

    removeDirectoryAt(subpath: string): void {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);
        console.log('[opfs-fs] removeDirectoryAt:', normalizedPath);

        // Check if directory exists in tree
        const entry = getTreeEntry(normalizedPath);
        if (!entry) {
            throw 'no-entry';
        }
        if (!entry.dir) {
            throw 'not-directory';
        }

        // Remove from OPFS (async)
        this.removeOpfsEntry(normalizedPath, true);

        // Remove from tree
        removeTreeEntry(normalizedPath);
    }

    renameAt(
        _oldPathFlags: number,
        oldPath: string,
        newDescriptor: Descriptor,
        newPath: string
    ): void {
        const oldFullPath = this.resolvePath(oldPath);
        const oldNormalized = normalizePath(oldFullPath);

        // Resolve new path relative to new descriptor
        const newFullPath = newDescriptor.resolvePath(newPath);
        const newNormalized = normalizePath(newFullPath);

        console.log('[opfs-fs] renameAt:', oldNormalized, '->', newNormalized);

        // Get old entry
        const oldEntry = getTreeEntry(oldNormalized);
        if (!oldEntry) {
            throw 'no-entry';
        }

        // Check if new path already exists
        const existingEntry = getTreeEntry(newNormalized);
        if (existingEntry) {
            throw 'exist';
        }

        // For files, handle sync handle
        if (oldEntry.dir === undefined) {
            const handle = syncHandleCache.get(oldNormalized);
            if (handle) {
                try {
                    handle.close();
                } catch (e) {
                    console.warn('[opfs-fs] Failed to close handle during rename:', oldNormalized, e);
                }
                syncHandleCache.delete(oldNormalized);
            }
        }

        // Copy entry to new location in tree
        setTreeEntry(newNormalized, oldEntry);

        // Remove from old location in tree
        removeTreeEntry(oldNormalized);

        // Move in OPFS (async operation)
        this.moveInOpfs(oldNormalized, newNormalized, oldEntry.dir !== undefined);
    }

    private moveInOpfs(oldPath: string, newPath: string, isDirectory: boolean): void {
        const move = async () => {
            try {
                if (isDirectory) {
                    // For directories, we need to create new and copy recursively, then delete old
                    // This is complex - for now just log
                    console.warn('[opfs-fs] Directory rename in OPFS not fully implemented:', oldPath, '->', newPath);
                    return;
                }

                // For files: read old content, create new file, write content, delete old
                const oldParts = oldPath.split('/').filter(p => p && p !== '.');
                const newParts = newPath.split('/').filter(p => p && p !== '.');

                if (oldParts.length === 0 || newParts.length === 0) return;

                const oldName = oldParts.pop()!;
                const newName = newParts.pop()!;

                const oldParent = oldParts.length > 0
                    ? await getOpfsDirectory(oldParts, false)
                    : opfsRoot;

                const newParent = newParts.length > 0
                    ? await getOpfsDirectory(newParts, true)
                    : opfsRoot;

                if (!oldParent || !newParent) {
                    console.error('[opfs-fs] Cannot find parent directories for move');
                    return;
                }

                // Get old file and read content
                const oldFileHandle = await oldParent.getFileHandle(oldName);
                const oldFile = await oldFileHandle.getFile();
                const content = await oldFile.arrayBuffer();

                // Create new file and write
                const newFileHandle = await newParent.getFileHandle(newName, { create: true });
                const writable = await newFileHandle.createWritable();
                await writable.write(content);
                await writable.close();

                // Acquire sync handle for new file
                const syncHandle = await newFileHandle.createSyncAccessHandle();
                syncHandleCache.set(newPath, syncHandle);

                // Delete old file
                await oldParent.removeEntry(oldName);

                console.log('[opfs-fs] Moved in OPFS:', oldPath, '->', newPath);
            } catch (e) {
                console.error('[opfs-fs] Failed to move in OPFS:', oldPath, '->', newPath, e);
            }
        };

        move();
    }

    /**
     * Create symbolic link - not supported in OPFS
     */
    symlinkAt(_oldPath: string, _newPath: string): void {
        console.warn('[opfs-fs] symlinkAt: symbolic links not supported');
        throw 'not-supported';
    }

    unlinkFileAt(subpath: string): void {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);
        console.log('[opfs-fs] unlinkFileAt:', normalizedPath);

        // Check if file exists in tree
        const entry = getTreeEntry(normalizedPath);
        if (!entry) {
            throw 'no-entry';
        }
        if (entry.dir !== undefined) {
            throw 'is-directory';
        }

        // Close and remove sync handle if cached
        const handle = syncHandleCache.get(normalizedPath);
        if (handle) {
            try {
                handle.close();
            } catch (e) {
                console.warn('[opfs-fs] Failed to close handle during unlink:', normalizedPath, e);
            }
            syncHandleCache.delete(normalizedPath);
        }

        // Remove from OPFS (async)
        this.removeOpfsEntry(normalizedPath, false);

        // Remove from tree
        removeTreeEntry(normalizedPath);
    }

    private removeOpfsEntry(path: string, isDirectory: boolean): void {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) return;

        const name = parts.pop()!;

        // Get parent directory
        const getParentAndRemove = async () => {
            try {
                const parentDir = parts.length > 0
                    ? await getOpfsDirectory(parts, false)
                    : opfsRoot;

                if (!parentDir) {
                    console.warn('[opfs-fs] No parent directory for removal:', path);
                    return;
                }

                if (isDirectory) {
                    await parentDir.removeEntry(name, { recursive: true });
                } else {
                    await parentDir.removeEntry(name);
                }
                console.log('[opfs-fs] Removed from OPFS:', path);
            } catch (e) {
                console.error('[opfs-fs] Failed to remove from OPFS:', path, e);
            }
        };

        getParentAndRemove();
    }
    isSameObject(other: Descriptor): boolean { return other === this; }
    metadataHash() { return { upper: BigInt(0), lower: BigInt(0) }; }
    metadataHashAt() { return { upper: BigInt(0), lower: BigInt(0) }; }
}

// ============================================================
// ASYNC HANDLE MANAGEMENT
// ============================================================

/**
 * Prepare a file for sync access - must be called before read/write
 * This opens a SyncAccessHandle and caches it
 */
export async function prepareFileForSync(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);

    if (syncHandleCache.has(normalizedPath)) {
        return; // Already prepared
    }

    try {
        const fileHandle = await getOpfsFile(normalizedPath, true);
        const syncHandle = await fileHandle.createSyncAccessHandle();
        syncHandleCache.set(normalizedPath, syncHandle);
    } catch (e) {
        console.error('[opfs-fs] Failed to prepare sync handle:', path, e);
        throw e;
    }
}

/**
 * Release a file's sync handle
 */
export function releaseFile(path: string): void {
    const normalizedPath = normalizePath(path);
    const handle = syncHandleCache.get(normalizedPath);
    if (handle) {
        handle.close();
        syncHandleCache.delete(normalizedPath);
    }
}

// ============================================================
// WASI EXPORTS
// ============================================================

// Root descriptor
const rootDescriptor = new Descriptor('', directoryTree);

export const preopens = {
    getDirectories(): Array<[Descriptor, string]> {
        return [[rootDescriptor, '/']];
    },
};

// filesystemErrorCode maps errors to WASI error codes
function filesystemErrorCode(): string | undefined {
    // Returns undefined - no error code translation needed for our implementation
    return undefined;
}

export const types = {
    Descriptor,
    DirectoryEntryStream,
    filesystemErrorCode,
};

export { types as filesystemTypes };
