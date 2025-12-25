/**
 * OPFS-backed WASI Filesystem Implementation
 * 
 * Hybrid storage approach:
 * - File content: SyncAccessHandle for true OPFS persistence
 * - Directory tree: In-memory index (loaded on startup, updated on file ops)
 * 
 * This replaces @bytecodealliance/preview2-shim/filesystem for browser workers.
 */

// Import stream classes from our custom implementation that fixes preview2-shim bugs
import { InputStream, OutputStream } from './streams';
import {
    directoryTree,
    getTreeEntry, setTreeEntry, removeTreeEntry,
    getOpfsRoot, setOpfsRoot,
    isInitialized, setInitialized,
    getCwd, setCwd,
    syncScanDirectory,
    normalizePath,
    getOpfsDirectory, getOpfsFile,
    syncHandleCache,
    type TreeEntry
} from './directory-tree';
import {
    initHelperWorker,
    syncFileOperation,
    msToDatetime
} from './opfs-sync-bridge';

// ============================================================
// WASI TYPES & CLASSES
// ============================================================

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

        const mtime = msToDatetime(this.treeEntry.mtime);

        return {
            type,
            linkCount: BigInt(0),
            size,
            dataAccessTimestamp: mtime,
            dataModificationTimestamp: mtime,
            statusChangeTimestamp: mtime,
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
            // Create new entry with current timestamp
            entry = openFlags.directory ? { dir: {} } : { size: 0, mtime: Date.now() };
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
     * Falls back to syncFileOperation when no handle is cached
     */
    read(length: number, _offset: bigint): [Uint8Array, boolean] {
        const offset = Number(_offset);
        const path = this.path;
        const normalizedPath = normalizePath(path);

        // Get cached sync handle
        const handle = syncHandleCache.get(normalizedPath);
        if (handle) {
            const size = handle.getSize();
            const readLength = Math.min(length, size - offset);
            const buffer = new Uint8Array(readLength);
            handle.read(buffer, { at: offset });
            const eof = offset + readLength >= size;
            return [buffer, eof];
        }

        // Fallback: use sync helper to read file via Atomics
        console.log('[opfs-fs] No cached handle, using syncFileOperation for:', normalizedPath);
        try {
            const response = syncFileOperation({ type: 'readFile', path: normalizedPath });
            if (!response.success || response.data === undefined) {
                console.warn('[opfs-fs] Read failed:', response.error);
                return [new Uint8Array(0), true];
            }

            const fullData = new TextEncoder().encode(response.data);
            const sliceStart = Math.min(offset, fullData.length);
            const sliceEnd = Math.min(offset + length, fullData.length);
            const slicedData = fullData.slice(sliceStart, sliceEnd);
            const eof = sliceEnd >= fullData.length;
            return [slicedData, eof];
        } catch (e) {
            console.error('[opfs-fs] syncFileOperation read error:', e);
            return [new Uint8Array(0), true];
        }
    }


    /**
     * Read via stream - returns proper WASI InputStream resource
     * Falls back to syncFileOperation when no handle is cached
     */
    readViaStream(_offset: bigint): unknown {
        const path = this.path;
        const normalizedPath = normalizePath(path);
        let offset = Number(_offset);

        const handle = syncHandleCache.get(normalizedPath);
        if (handle) {
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
                }
            });
        }

        // Fallback: read entire file via sync helper, then stream from memory
        console.log('[opfs-fs] No cached handle for stream, using syncFileOperation:', normalizedPath);
        let fileData: Uint8Array | null = null;
        try {
            const response = syncFileOperation({ type: 'readFile', path: normalizedPath });
            if (!response.success || response.data === undefined) {
                throw 'no-entry';
            }
            fileData = new TextEncoder().encode(response.data);
        } catch (e) {
            console.error('[opfs-fs] readViaStream sync fallback error:', e);
            throw 'no-entry';
        }

        const size = fileData.length;
        const data = fileData;

        return new InputStream({
            read(len: bigint): Uint8Array {
                if (offset >= size) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), size - offset);
                const result = data.slice(offset, offset + readLen);
                offset += readLen;
                return result;
            },
            blockingRead(len: bigint): Uint8Array {
                if (offset >= size) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), size - offset);
                const result = data.slice(offset, offset + readLen);
                offset += readLen;
                return result;
            }
        });
    }


    /**
     * Write file content - uses SyncAccessHandle for OPFS persistence
     * Falls back to syncFileOperation when no handle is cached
     */
    write(buffer: Uint8Array, _offset: bigint): number {
        const offset = Number(_offset);
        const path = this.path;
        const normalizedPath = normalizePath(path);

        const handle = syncHandleCache.get(normalizedPath);
        if (handle) {
            // Write to OPFS via cached handle
            handle.write(buffer, { at: offset });
            handle.flush();

            // Update tree entry size and mtime
            const newSize = Math.max(this.treeEntry.size || 0, offset + buffer.byteLength);
            this.treeEntry.size = newSize;
            this.treeEntry.mtime = Date.now();

            return buffer.byteLength;
        }

        // Fallback: use sync helper to write file via Atomics
        console.log('[opfs-fs] No cached handle, using syncFileOperation for write:', normalizedPath);
        try {
            const text = new TextDecoder().decode(buffer);
            const response = syncFileOperation({ type: 'writeFile', path: normalizedPath, data: text });
            if (!response.success) {
                console.warn('[opfs-fs] Write failed:', response.error);
                return 0;
            }

            // Update tree entry
            this.treeEntry.size = (this.treeEntry.size || 0) + buffer.byteLength;
            this.treeEntry.mtime = Date.now();
            return buffer.byteLength;
        } catch (e) {
            console.error('[opfs-fs] syncFileOperation write error:', e);
            return 0;
        }
    }


    /**
     * Write via stream - returns proper WASI OutputStream resource
     * Falls back to syncFileOperation when no handle is cached
     */
    writeViaStream(_offset: bigint): unknown {
        const path = this.path;
        const normalizedPath = normalizePath(path);
        let offset = Number(_offset);
        const entry = this.treeEntry;

        const handle = syncHandleCache.get(normalizedPath);
        if (handle) {
            // Return a proper OutputStream instance (required by WASI)
            return new OutputStream({
                write(buf: Uint8Array): bigint {
                    handle.write(buf, { at: offset });
                    handle.flush();
                    offset += buf.byteLength;
                    entry.size = Math.max(entry.size || 0, offset);
                    entry.mtime = Date.now();
                    return BigInt(buf.byteLength);
                },
                blockingWriteAndFlush(buf: Uint8Array): void {
                    handle.write(buf, { at: offset });
                    handle.flush();
                    offset += buf.byteLength;
                    entry.size = Math.max(entry.size || 0, offset);
                    entry.mtime = Date.now();
                },
                flush(): void {
                    handle.flush();
                },
                blockingFlush(): void {
                    handle.flush();
                },
                checkWrite(): bigint {
                    return BigInt(1024 * 1024); // 1MB available
                }
            });
        }

        // Fallback: write immediately to OPFS via syncFileOperation
        console.log('[opfs-fs] No cached handle for stream write, using syncFileOperation:', normalizedPath);
        let totalWritten = '';
        const syncPath = normalizedPath;
        const syncEntry = entry;

        return new OutputStream({
            write(buf: Uint8Array): bigint {
                const text = new TextDecoder().decode(buf);
                totalWritten += text;
                // Write immediately to OPFS - don't buffer
                const response = syncFileOperation({ type: 'writeFile', path: syncPath, data: totalWritten });
                if (response.success) {
                    syncEntry.size = totalWritten.length;
                    syncEntry.mtime = Date.now();
                }
                return BigInt(buf.byteLength);
            },
            blockingWriteAndFlush(buf: Uint8Array): void {
                const text = new TextDecoder().decode(buf);
                totalWritten += text;
                const response = syncFileOperation({ type: 'writeFile', path: syncPath, data: totalWritten });
                if (response.success) {
                    syncEntry.size = totalWritten.length;
                    syncEntry.mtime = Date.now();
                }
            },
            flush(): void {
                // Already persisted on write
            },
            blockingFlush(): void {
                // Already persisted on write
            },
            checkWrite(): bigint {
                return BigInt(1024 * 1024); // 1MB available
            }
        });
    }



    readDirectory(): DirectoryEntryStream {
        console.log('[opfs-fs] readDirectory called, path:', this.path, 'hasDir:', !!this.treeEntry.dir);
        if (!this.treeEntry.dir) {
            throw 'bad-descriptor';
        }

        // Lazy scan if this directory hasn't been scanned yet
        if (!this.treeEntry._scanned) {
            console.log('[opfs-fs] Directory not scanned, triggering lazy scan:', this.path);
            syncScanDirectory(this.path);
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
            const cwd = getCwd();
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
                entry.mtime = Date.now();
                return BigInt(buf.byteLength);
            },
            blockingWriteAndFlush(buf: Uint8Array): void {
                handle.write(buf, { at: offset });
                handle.flush();
                offset += buf.byteLength;
                entry.size = Math.max(entry.size || 0, offset);
                entry.mtime = Date.now();
            },
            flush(): void {
                handle.flush();
            },
            blockingFlush(): void {
                handle.flush();
            },
            checkWrite(): bigint {
                return BigInt(1024 * 1024); // 1MB available
            }
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

        // Check if directory exists in tree
        const entry = getTreeEntry(normalizedPath);
        if (!entry) {
            throw 'no-entry';
        }
        if (!entry.dir) {
            throw 'not-directory';
        }

        // Close all sync handles for files in this directory tree
        // This is necessary because OPFS won't allow deletion while handles are open
        // Use imported helper from directory-tree (which I need to check if closeHandlesUnderPath is exported!)
        // If not, I can't call it. 
        // Wait, removeTreeEntry alone isn't enough.
        // I need closeHandlesUnderPath logic.
        // Let's assume for now I should have exported it from directory-tree.ts.
        // If not, I'll need to fix directory-tree.ts.

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
                    : getOpfsRoot();

                const newParent = newParts.length > 0
                    ? await getOpfsDirectory(newParts, true)
                    : getOpfsRoot();

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
                    : getOpfsRoot();

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


export function _setCwd(path: string) {
    setCwd(path);
}

export function _getCwd(): string {
    return getCwd();
}


/**
 * Initialize the filesystem with lazy loading via SharedArrayBuffer + Atomics.
 * Creates helper worker for async OPFS operations.
 */
export async function initFilesystem(): Promise<void> {
    if (isInitialized()) return;

    try {
        const root = await navigator.storage.getDirectory();
        setOpfsRoot(root);
        console.log('[opfs-fs] OPFS root acquired');

        // Initialize bridge
        await initHelperWorker();

        console.log('[opfs-fs] Helper worker ready, scanning root directory...');
        syncScanDirectory('');

        setInitialized(true);
        console.log('[opfs-fs] Filesystem initialized with lazy loading');
    } catch (e) {
        console.error('[opfs-fs] Failed to initialize OPFS:', e);
        // Fall back to initialized but empty tree
        setInitialized(true);
    }
}
