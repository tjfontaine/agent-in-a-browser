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
// Import OPFS utilities (no more in-memory tree!)
import {
    getOpfsRoot, setOpfsRoot,
    isInitialized, setInitialized,
    getCwd, setCwd,
    normalizePath,
    resolveSymlinks,
    getOpfsDirectory, getOpfsFile,
    syncHandleCache,
    asyncWriteFile,
    asyncReadFile,
    loadSymlinksIntoCache,
    addSymlinkToCache,
    removeSymlinkFromCache,
    getSymlinkTarget,
    // OPFS-direct functions
    getEntryFromOpfs,
    getTreeEntryWithScan,
    type TreeEntry
} from './directory-tree';
import {
    initHelperWorker,
    syncReadFileBinary,
    syncWriteFileBinary,
    msToDatetime
} from './opfs-sync-bridge';
import {
    saveSymlink,
    deleteSymlink,
    deleteSymlinksUnderPath
} from './symlink-store';

// Global buffer cache for files being written via streams without sync handles.
// This persists data across writeViaStream() calls since each call creates a new OutputStream.
// Key: normalized file path, Value: accumulated binary data
const fileBufferCache = new Map<string, Uint8Array>();

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
        let type = 'regular-file';
        if (entry.dir) {
            type = 'directory';
        } else if (entry.symlink) {
            type = 'symbolic-link';
        }
        return { name, type };
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

    async statAt(pathFlags: number, subpath: string) {
        const fullPath = this.resolvePath(subpath);
        const shouldFollow = (pathFlags & 1) !== 0; // symlinkFollow flag
        const resolvedPath = shouldFollow ? resolveSymlinks(fullPath) : fullPath;
        const entry = await getEntryFromOpfs(resolvedPath);

        if (!entry) {
            throw 'no-entry';
        }

        let type = 'unknown';
        let size = BigInt(0);

        if (entry.dir !== undefined) {
            type = 'directory';
        } else if (entry.symlink !== undefined) {
            type = 'symbolic-link';
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

    async openAt(
        _pathFlags: number,
        subpath: string,
        openFlags: { create?: boolean; directory?: boolean; truncate?: boolean },
        _descriptorFlags: number,
        _modes: number
    ): Promise<Descriptor> {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);

        // Use async tree entry lookup that scans directories lazily
        let entry = await getTreeEntryWithScan(fullPath);

        if (!entry && openFlags.create) {
            // Create new entry with current timestamp
            entry = openFlags.directory ? { dir: {} } : { size: 0, mtime: Date.now() };

            // Create in OPFS (async, but we'll handle sync access later)
            if (!openFlags.directory) {
                this.createOpfsFile(fullPath);
            } else {
                this.createOpfsDirectory(fullPath);
            }
        }

        // Handle truncate: clear any buffered data for this file
        if (openFlags.truncate && entry && !entry.dir) {
            fileBufferCache.delete(normalizedPath);
            console.log('[opfs-fs] openAt truncate: cleared buffer cache for', normalizedPath);
        }

        if (!entry) {
            throw 'no-entry';
        }

        // For files (not directories), verify the file actually exists in OPFS
        // This catches race conditions where tree is updated but OPFS is out of sync
        if (entry.dir === undefined && entry.symlink === undefined && !openFlags.create) {
            // Check if we have a cached sync handle (confirms file exists)
            if (!syncHandleCache.has(normalizedPath)) {
                // Try to verify file exists in OPFS
                try {
                    await getOpfsFile(normalizedPath, false);
                } catch (_e) {
                    // File doesn't exist in OPFS
                    console.warn('[opfs-fs] openAt: file not in OPFS:', normalizedPath);
                    throw 'no-entry';
                }
            }
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

    async createDirectoryAt(subpath: string): Promise<void> {
        const fullPath = this.resolvePath(subpath);
        const existing = await getEntryFromOpfs(fullPath);

        if (existing) {
            throw 'exist';
        }

        // Just create in OPFS directly - no tree update needed
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
        console.log('[opfs-fs] Descriptor.read called, length:', length, 'offset:', offset, 'path:', normalizedPath);

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

        // Fallback: use sync helper to read file via Atomics (binary-safe)
        console.log('[opfs-fs] No cached handle, using syncReadFileBinary for:', normalizedPath);
        try {
            const fullData = syncReadFileBinary(normalizedPath);
            const sliceStart = Math.min(offset, fullData.length);
            const sliceEnd = Math.min(offset + length, fullData.length);
            const slicedData = fullData.slice(sliceStart, sliceEnd);
            const eof = sliceEnd >= fullData.length;
            return [slicedData, eof];
        } catch (e) {
            console.error('[opfs-fs] syncReadFileBinary error:', e);
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
        console.log('[opfs-fs] readViaStream called, path:', normalizedPath, 'offset:', offset);

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

        // Fallback: use async read via OPFS APIs (JSPI will suspend on the Promise)
        // We need to read the file lazily on first blockingRead call
        console.log('[opfs-fs] No cached handle for stream, using asyncReadFile:', normalizedPath);

        let fileData: Uint8Array | null = null;
        let fileSize = 0;
        const asyncPath = normalizedPath;

        return new InputStream({
            read(len: bigint): Uint8Array {
                // For non-blocking read, if we haven't loaded yet, return empty
                // (caller should use blockingRead for actual data)
                if (!fileData) {
                    return new Uint8Array(0);
                }
                if (offset >= fileSize) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), fileSize - offset);
                const result = fileData.slice(offset, offset + readLen);
                offset += readLen;
                return result;
            },
            async blockingRead(len: bigint): Promise<Uint8Array> {
                // Lazy load file on first read
                if (fileData === null) {
                    try {
                        fileData = await asyncReadFile(asyncPath);
                        fileSize = fileData.length;
                    } catch (e) {
                        console.error('[opfs-fs] readViaStream async fallback error:', e);
                        // Set to empty array to signal EOF rather than hanging
                        fileData = new Uint8Array(0);
                        fileSize = 0;
                    }
                }

                if (offset >= fileSize) {
                    return new Uint8Array(0);
                }
                const readLen = Math.min(Number(len), fileSize - offset);
                const result = fileData.slice(offset, offset + readLen);
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
        console.log('[opfs-fs] Descriptor.write called, buffer.length:', buffer.length, 'offset:', offset, 'path:', normalizedPath);

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

        // Fallback: use sync helper to write file via Atomics (binary-safe)
        console.log('[opfs-fs] No cached handle, using syncWriteFileBinary for:', normalizedPath);
        try {
            syncWriteFileBinary(normalizedPath, buffer);

            // Update tree entry
            this.treeEntry.size = (this.treeEntry.size || 0) + buffer.byteLength;
            this.treeEntry.mtime = Date.now();
            return buffer.byteLength;
        } catch (e) {
            console.error('[opfs-fs] syncWriteFileBinary error:', e);
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

        // Fallback: write via async OPFS APIs (JSPI will suspend on the Promise)
        // Use global buffer cache to persist data across stream re-opens (ZipWriter seeks cause multiple writeViaStream calls)
        console.log('[opfs-fs] No cached handle for stream write, using async write:', normalizedPath);
        const asyncPath = normalizedPath;
        const asyncEntry = entry;

        // Initialize buffer in cache if not present, or get existing buffer
        if (!fileBufferCache.has(asyncPath)) {
            fileBufferCache.set(asyncPath, new Uint8Array(0));
        }

        return new OutputStream({
            write(buf: Uint8Array): bigint {
                const existingData = fileBufferCache.get(asyncPath) || new Uint8Array(0);
                console.log('[opfs-fs] writeViaStream.write called, buf.length:', buf.length, 'cached:', existingData.length);

                // Accumulate binary data in cache
                const newData = new Uint8Array(existingData.length + buf.length);
                newData.set(existingData);
                newData.set(buf, existingData.length);
                fileBufferCache.set(asyncPath, newData);

                // Write async - JSPI will handle the Promise
                asyncWriteFile(asyncPath, newData).then(() => {
                    asyncEntry.size = newData.length;
                    asyncEntry.mtime = Date.now();
                    console.log('[opfs-fs] writeViaStream.write completed, total size:', newData.length);
                }).catch(e => {
                    console.error('[opfs-fs] writeViaStream async write error:', e);
                });
                return BigInt(buf.byteLength);
            },
            // blockingWriteAndFlush RETURNS a Promise when using async path - JSPI will suspend
            blockingWriteAndFlush(buf: Uint8Array): Promise<void> | void {
                const existingData = fileBufferCache.get(asyncPath) || new Uint8Array(0);

                // Accumulate binary data in cache
                const newData = new Uint8Array(existingData.length + buf.length);
                newData.set(existingData);
                newData.set(buf, existingData.length);
                fileBufferCache.set(asyncPath, newData);

                // Return Promise - JSPI will suspend on it
                return asyncWriteFile(asyncPath, newData).then(() => {
                    asyncEntry.size = newData.length;
                    asyncEntry.mtime = Date.now();
                }).catch(e => {
                    console.error('[opfs-fs] writeViaStream async blockingWrite error:', e);
                });
            },
            flush(): void {
                // Clear the buffer cache for this file since it's been flushed
                // (Data is already persisted on each write)
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

        // Get directory entries directly from OPFS
        // Note: This creates a new DirectoryEntryStream from current treeEntry.dir
        // but with OPFS-direct approach, we should fetch from OPFS instead
        const entries = Object.entries(this.treeEntry.dir || {}).sort(([a], [b]) => a > b ? 1 : -1);
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
     * Read symbolic link - returns target path
     */
    readlinkAt(subpath: string): string {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);

        // Check symlink cache (populated from IndexedDB)
        const target = getSymlinkTarget(normalizedPath);
        if (!target) {
            throw 'no-entry'; // Not a symlink or doesn't exist
        }

        return target;
    }

    async removeDirectoryAt(subpath: string): Promise<void> {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);

        // Check if directory exists in OPFS directly
        const entry = await getEntryFromOpfs(normalizedPath);
        if (!entry) {
            throw 'no-entry';
        }
        if (!entry.dir) {
            throw 'not-directory';
        }

        // Delete any symlinks under this directory from IndexedDB
        deleteSymlinksUnderPath(normalizedPath).catch(e => {
            console.error('[opfs-fs] Failed to cascade delete symlinks:', normalizedPath, e);
        });

        // Remove from OPFS (async)
        this.removeOpfsEntry(normalizedPath, true);
    }

    async renameAt(
        _oldPathFlags: number,
        oldPath: string,
        newDescriptor: Descriptor,
        newPath: string
    ): Promise<void> {
        const oldFullPath = this.resolvePath(oldPath);
        const oldNormalized = normalizePath(oldFullPath);

        // Resolve new path relative to new descriptor
        const newFullPath = newDescriptor.resolvePath(newPath);
        const newNormalized = normalizePath(newFullPath);

        console.log('[opfs-fs] renameAt:', oldNormalized, '->', newNormalized);

        // Get old entry from OPFS
        const oldEntry = await getEntryFromOpfs(oldNormalized);
        if (!oldEntry) {
            throw 'no-entry';
        }

        // Check if new path already exists in OPFS
        const existingEntry = await getEntryFromOpfs(newNormalized);
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
     * Create symbolic link - stored in symlink cache and persisted to IndexedDB
     */
    async symlinkAt(targetPath: string, linkName: string): Promise<void> {
        const fullPath = this.resolvePath(linkName);
        const normalizedPath = normalizePath(fullPath);

        // Check if something already exists at link path in OPFS
        const existing = await getEntryFromOpfs(normalizedPath);
        if (existing) {
            throw 'exist';
        }

        // Add to symlink cache
        addSymlinkToCache(normalizedPath, targetPath);

        // Persist to IndexedDB (async, fire-and-forget)
        saveSymlink(normalizedPath, targetPath).catch(e => {
            console.error('[opfs-fs] Failed to persist symlink to IndexedDB:', normalizedPath, e);
        });
    }

    async unlinkFileAt(subpath: string): Promise<void> {
        const fullPath = this.resolvePath(subpath);
        const normalizedPath = normalizePath(fullPath);

        // Check if file exists in OPFS directly
        const entry = await getEntryFromOpfs(normalizedPath);
        if (!entry) {
            throw 'no-entry';
        }
        if (entry.dir !== undefined) {
            throw 'is-directory';
        }

        // If it's a symlink, delete from IndexedDB and cache
        if (entry.symlink !== undefined) {
            deleteSymlink(normalizedPath).catch(e => {
                console.error('[opfs-fs] Failed to delete symlink from IndexedDB:', normalizedPath, e);
            });
            removeSymlinkFromCache(normalizedPath);
            return;
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

// Root descriptor - represents the root directory
const rootDescriptor = new Descriptor('', { dir: {} });

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

        console.log('[opfs-fs] Helper worker ready, loading symlinks...');

        // Load symlinks from IndexedDB into cache
        await loadSymlinksIntoCache();
        console.log('[opfs-fs] Symlinks loaded into cache');

        setInitialized(true);
        console.log('[opfs-fs] Filesystem initialized with lazy loading');
    } catch (e) {
        console.error('[opfs-fs] Failed to initialize OPFS:', e);
        // Fall back to initialized but empty tree
        setInitialized(true);
    }
}
