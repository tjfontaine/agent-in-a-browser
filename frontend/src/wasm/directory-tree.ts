/**
 * Directory Tree Management
 * 
 * In-memory directory tree for WASI filesystem.
 * File content is persisted via OPFS, tree is loaded on startup.
 */

// Note: With JSPI, we no longer use Atomics.wait for sync operations.
// Instead, we use async OPFS APIs and JSPI suspends the WASM stack automatically.

// ============================================================
// TYPES
// ============================================================

export interface TreeEntry {
    dir?: Record<string, TreeEntry>;
    size?: number;
    mtime?: number; // Unix timestamp in milliseconds
    symlink?: string; // If set, this is a symlink pointing to this target path
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
// ASYNC DIRECTORY SCAN (for JSPI)
// ============================================================

/**
 * Scan a directory using async OPFS APIs.
 * With JSPI, returning a Promise will suspend the WASM stack automatically.
 * No Atomics.wait needed!
 */
export async function syncScanDirectory(path: string): Promise<boolean> {
    if (!opfsRoot) {
        console.warn('[opfs-fs] OPFS root not set, cannot scan:', path);
        return false;
    }

    try {
        // Navigate to the target directory
        let targetDir: FileSystemDirectoryHandle = opfsRoot;
        const parts = path.split('/').filter(p => p && p !== '.');

        for (const part of parts) {
            try {
                targetDir = await targetDir.getDirectoryHandle(part);
            } catch {
                console.warn('[opfs-fs] Directory not found:', path);
                return false;
            }
        }

        // Scan directory entries
        const entries: Array<{ name: string; kind: 'file' | 'directory'; size?: number; mtime?: number }> = [];

        for await (const [name, handle] of (targetDir as any).entries()) {
            if (handle.kind === 'file') {
                // Get file size if possible
                try {
                    const file = await (handle as FileSystemFileHandle).getFile();
                    entries.push({
                        name,
                        kind: 'file',
                        size: file.size,
                        mtime: file.lastModified
                    });
                } catch {
                    entries.push({ name, kind: 'file', size: 0, mtime: Date.now() });
                }
            } else {
                entries.push({ name, kind: 'directory' });
            }
        }

        // Update tree with scan results
        const entry = path === '' || path === '/' ? directoryTree : getTreeEntry(path);
        if (entry && entry.dir !== undefined) {
            for (const item of entries) {
                if (item.kind === 'directory') {
                    if (!entry.dir[item.name]) {
                        entry.dir[item.name] = { dir: {}, _scanned: false };
                    }
                } else {
                    entry.dir[item.name] = { size: item.size, mtime: item.mtime };
                }
            }
            entry._scanned = true;
            console.log('[opfs-fs] Scanned', path || '/', 'with', entries.length, 'entries');
        }

        return true;
    } catch (e) {
        console.error('[opfs-fs] Error scanning directory:', path, e);
        return false;
    }
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
 * Resolve symlinks in a path.
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
        const entry = getTreeEntry(currentPath);

        if (entry?.symlink) {
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
            if (entry.symlink.startsWith('/')) {
                target = entry.symlink;
            } else {
                // Relative symlink: resolve relative to parent of current
                const parent = resolved.slice(0, -1).join('/');
                target = parent ? parent + '/' + entry.symlink : entry.symlink;
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


