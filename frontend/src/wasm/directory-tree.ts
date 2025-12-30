/**
 * OPFS Filesystem Utilities
 * 
 * Direct OPFS access utilities for WASI filesystem.
 * No in-memory tree - all operations go directly to OPFS.
 * Symlinks are stored in IndexedDB (symlink-store.ts).
 */

import { loadAllSymlinks } from './symlink-store';

// ============================================================
// TYPES (kept for API compatibility with Descriptor class)
// ============================================================

export interface TreeEntry {
    dir?: Record<string, TreeEntry>;  // Present if this is a directory
    size?: number;                     // File size in bytes
    mtime?: number;                    // Unix timestamp in milliseconds
    symlink?: string;                  // If set, this is a symlink pointing to this target path
}

// ============================================================
// STATE
// ============================================================

let opfsRoot: FileSystemDirectoryHandle | null = null;
let initialized = false;

// Current working directory
let cwd = '/';

// Cache of open SyncAccessHandles for files (performance optimization)
export const syncHandleCache = new Map<string, FileSystemSyncAccessHandle>();

// Cache of symlinks (loaded from IndexedDB at startup)
let symlinkCache: Map<string, string> = new Map();

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

/**
 * Load symlinks from IndexedDB into cache
 */
export async function loadSymlinksIntoCache(): Promise<void> {
    symlinkCache = await loadAllSymlinks();
    console.log('[opfs-fs] Loaded', symlinkCache.size, 'symlinks from IndexedDB');
}

/**
 * Update symlink cache when symlink is created
 */
export function addSymlinkToCache(path: string, target: string): void {
    symlinkCache.set(normalizePath(path), target);
}

/**
 * Remove symlink from cache when deleted
 */
export function removeSymlinkFromCache(path: string): void {
    symlinkCache.delete(normalizePath(path));
}

/**
 * Check if path is a symlink (from cache)
 */
export function getSymlinkTarget(path: string): string | undefined {
    return symlinkCache.get(normalizePath(path));
}

// ============================================================
// PATH UTILITIES
// ============================================================

export function normalizePath(path: string): string {
    if (!path || path === '/') return '';
    // Remove leading/trailing slashes, split, filter out empty and '.' components, rejoin
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(p => p && p !== '.');
    return parts.join('/');
}

/**
 * Resolve symlinks in a path using the symlink cache.
 * @param path The path to resolve
 * @param followFinal If true, follow the final component if it's a symlink
 * @returns The resolved path with all symlinks followed
 * @throws 'loop' if symlink loop detected (ELOOP)
 */
export function resolveSymlinks(path: string, followFinal = true): string {
    const parts = normalizePath(path).split('/').filter(p => p);
    if (parts.length === 0) return '';

    const resolved: string[] = [];
    let loopCount = 0;
    const maxLoops = 40; // POSIX SYMLOOP_MAX

    for (let i = 0; i < parts.length; i++) {
        resolved.push(parts[i]);
        const currentPath = resolved.join('/');
        const symlinkTarget = symlinkCache.get(currentPath);

        if (symlinkTarget) {
            const isLast = i === parts.length - 1;
            if (isLast && !followFinal) {
                // Don't follow final symlink
                break;
            }

            if (++loopCount > maxLoops) {
                throw 'loop'; // ELOOP
            }

            // Resolve symlink target (can be relative or absolute)
            let target: string;
            if (symlinkTarget.startsWith('/')) {
                target = symlinkTarget;
            } else {
                // Relative symlink: resolve relative to parent of current
                const parent = resolved.slice(0, -1).join('/');
                target = parent ? parent + '/' + symlinkTarget : symlinkTarget;
            }

            // Replace resolved path with target and restart resolution
            const targetParts = normalizePath(target).split('/').filter(p => p);
            resolved.length = 0;
            resolved.push(...targetParts);

            // Append remaining path components
            const remaining = parts.slice(i + 1);
            parts.length = 0;
            parts.push(...resolved, ...remaining);
            resolved.length = 0;
            i = -1; // Restart loop
        }
    }

    return resolved.join('/');
}

// ============================================================
// OPFS HANDLE MANAGEMENT
// ============================================================

/**
 * Get or create OPFS directory handle for a path
 */
export async function getOpfsDirectory(pathParts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS root not set');

    let current = opfsRoot;
    for (const part of pathParts) {
        current = await current.getDirectoryHandle(part, { create });
    }
    return current;
}

/**
 * Get OPFS file handle for a path
 */
export async function getOpfsFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw new Error('OPFS root not set');

    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split('/').filter(p => p);
    if (parts.length === 0) throw new Error('Cannot get file handle for root');

    const fileName = parts.pop()!;
    const parentDir = parts.length > 0
        ? await getOpfsDirectory(parts, create)
        : opfsRoot;

    return await parentDir.getFileHandle(fileName, { create });
}

/**
 * Check if a file exists in OPFS
 */
export async function fileExistsInOpfs(path: string): Promise<boolean> {
    try {
        await getOpfsFile(path, false);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a directory exists in OPFS
 */
export async function directoryExistsInOpfs(path: string): Promise<boolean> {
    if (!path || path === '/' || path === '') return true; // Root always exists

    const parts = normalizePath(path).split('/').filter(p => p);
    if (parts.length === 0) return true;

    try {
        await getOpfsDirectory(parts, false);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get file metadata from OPFS
 */
export async function getFileStats(path: string): Promise<{ size: number; mtime: number } | null> {
    try {
        const fileHandle = await getOpfsFile(path, false);
        const file = await fileHandle.getFile();
        return {
            size: file.size,
            mtime: file.lastModified
        };
    } catch {
        return null;
    }
}

// ============================================================
// ENTRY LOOKUP FROM OPFS (replaces in-memory tree)
// ============================================================

/**
 * Get a TreeEntry by fetching info directly from OPFS.
 * This replaces the old getTreeEntry which used an in-memory tree.
 * Returns undefined if the path doesn't exist.
 */
export async function getEntryFromOpfs(path: string): Promise<TreeEntry | undefined> {
    const normalizedPath = normalizePath(path);

    // Check for symlink first (stored in cache from IndexedDB)
    const symlinkTarget = symlinkCache.get(normalizedPath);
    if (symlinkTarget !== undefined) {
        return { symlink: symlinkTarget };
    }

    // Root is always a directory
    if (!normalizedPath || normalizedPath === '') {
        return { dir: {} };
    }

    const parts = normalizedPath.split('/').filter(p => p);

    // Try as directory first
    try {
        await getOpfsDirectory(parts, false);
        return { dir: {} };
    } catch {
        // Not a directory, try as file
    }

    // Try as file
    try {
        const fileHandle = await getOpfsFile(normalizedPath, false);
        const file = await fileHandle.getFile();
        return {
            size: file.size,
            mtime: file.lastModified
        };
    } catch {
        // File doesn't exist
        return undefined;
    }
}

// Legacy aliases for compatibility
export const getTreeEntryWithScan = getEntryFromOpfs;
export const getTreeEntry = (path: string): TreeEntry | undefined => {
    // Sync version - only works for symlinks (cached)
    const symlinkTarget = symlinkCache.get(normalizePath(path));
    if (symlinkTarget !== undefined) {
        return { symlink: symlinkTarget };
    }
    // For files/dirs, caller must use async version
    console.warn('[opfs-fs] getTreeEntry is deprecated, use getEntryFromOpfs (async)');
    return undefined;
};

// No-op functions for removed tree operations
export function setTreeEntry(_path: string, _entry: TreeEntry): void {
    // No-op - OPFS is source of truth now
}

export function removeTreeEntry(_path: string): void {
    // No-op - OPFS is source of truth now
}

export async function syncScanDirectory(_path: string): Promise<boolean> {
    // No-op - no tree to scan into
    return true;
}

/**
 * Close all open sync handles (call on shutdown)
 */
export function closeAllHandles(): void {
    for (const [path, handle] of syncHandleCache.entries()) {
        try {
            handle.close();
            console.log('[opfs-fs] Closed sync handle:', path);
        } catch (e) {
            console.warn('[opfs-fs] Failed to close sync handle:', path, e);
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
    const toClose: string[] = [];

    for (const [path] of syncHandleCache.entries()) {
        if (path === pathPrefix || path.startsWith(prefix)) {
            toClose.push(path);
        }
    }

    for (const path of toClose) {
        const handle = syncHandleCache.get(path);
        if (handle) {
            try {
                handle.close();
                console.log('[opfs-fs] Closed sync handle under path:', path);
            } catch (e) {
                console.warn('[opfs-fs] Failed to close sync handle:', path, e);
            }
            syncHandleCache.delete(path);
        }
    }
}

// ============================================================
// ASYNC FILE OPERATIONS (for JSPI)
// ============================================================

/**
 * Write file content asynchronously using OPFS APIs.
 * Returns a Promise that JSPI will suspend on.
 */
export async function asyncWriteFile(path: string, data: Uint8Array): Promise<void> {
    const normalizedPath = normalizePath(path);

    // Close existing sync handle if any (we're about to rewrite)
    const existingHandle = syncHandleCache.get(normalizedPath);
    if (existingHandle) {
        try {
            existingHandle.close();
        } catch (e) {
            console.warn('[opfs-fs] Failed to close existing handle before async write:', e);
        }
        syncHandleCache.delete(normalizedPath);
    }

    try {
        // Get file handle (create if needed)
        const fileHandle = await getOpfsFile(normalizedPath, true);

        // Use writable stream to write content
        const writable = await fileHandle.createWritable();
        await writable.write(new Uint8Array(data).buffer as ArrayBuffer);
        await writable.close();

        console.log('[opfs-fs] Async write complete:', normalizedPath, data.length, 'bytes');
    } catch (e) {
        console.error('[opfs-fs] Async write failed:', normalizedPath, e);
        throw e;
    }
}

/**
 * Read file content asynchronously using OPFS APIs.
 * Returns a Promise that JSPI will suspend on.
 */
export async function asyncReadFile(path: string): Promise<Uint8Array> {
    const normalizedPath = normalizePath(path);

    try {
        // Close existing sync handle to ensure we read latest content
        const existingHandle = syncHandleCache.get(normalizedPath);
        if (existingHandle) {
            try {
                existingHandle.close();
            } catch (e) {
                console.warn('[opfs-fs] Failed to close existing handle before async read:', e);
            }
            syncHandleCache.delete(normalizedPath);
        }

        const fileHandle = await getOpfsFile(normalizedPath, false);
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        return new Uint8Array(buffer);
    } catch (e) {
        console.error('[opfs-fs] Failed to read file:', normalizedPath, e);
        throw e;
    }
}

/**
 * List directory contents directly from OPFS
 */
export async function listDirectory(path: string): Promise<Array<{ name: string; isDirectory: boolean; size?: number; mtime?: number }>> {
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath ? normalizedPath.split('/').filter(p => p) : [];

    const dirHandle = parts.length > 0
        ? await getOpfsDirectory(parts, false)
        : opfsRoot;

    if (!dirHandle) throw new Error('Directory not found');

    const entries: Array<{ name: string; isDirectory: boolean; size?: number; mtime?: number }> = [];

    for await (const [name, handle] of (dirHandle as any).entries()) {
        if (handle.kind === 'file') {
            const file = await (handle as FileSystemFileHandle).getFile();
            entries.push({
                name,
                isDirectory: false,
                size: file.size,
                mtime: file.lastModified
            });
        } else {
            entries.push({
                name,
                isDirectory: true
            });
        }
    }

    return entries;
}
