/**
 * OPFS Adapter for isomorphic-git
 *
 * This module provides a `fs` interface compatible with isomorphic-git
 * that uses our OPFS-backed filesystem. This allows git operations
 * to use the same storage as the rest of the shell.
 * 
 * All operations go directly to OPFS, not in-memory tree.
 */

import {
    normalizePath,
    getOpfsDirectory,
    getOpfsFile,
    asyncReadFile,
    asyncWriteFile,
    listDirectory,
    fileExistsInOpfs,
    directoryExistsInOpfs,
    getOpfsRoot,
} from './directory-tree';

// isomorphic-git expects a Node.js-like fs API
// We implement the subset that isomorphic-git actually uses

export interface Stats {
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

function createStats(isDir: boolean, size: number, mtime: number, path: string): Stats {
    return {
        type: isDir ? 'dir' : 'file',
        mode: isDir ? 0o40755 : 0o100644,
        size,
        ino: hashPath(path),
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

function hashPath(path: string): number {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
        hash = ((hash << 5) - hash) + path.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

/**
 * Create a Node.js-style error with code property for isomorphic-git compatibility
 */
function createFsError(code: string, message: string): Error {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
}

/**
 * OPFS-backed filesystem for isomorphic-git
 * All operations go directly to OPFS, no in-memory caching.
 */
export const opfsFs = {
    promises: {
        async readFile(
            filepath: string,
            options?: { encoding?: string } | string
        ): Promise<Uint8Array | string> {
            const path = normalizePath(filepath);

            // Handle empty path - isomorphic-git uses this for fs type detection
            if (!path || path === '' || path === '/') {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`);
            }

            try {
                const data = await asyncReadFile(path);
                const encoding = typeof options === 'string' ? options : options?.encoding;
                if (encoding === 'utf8' || encoding === 'utf-8') {
                    return new TextDecoder().decode(data);
                }
                return data;
            } catch {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`);
            }
        },

        async writeFile(
            filepath: string,
            data: Uint8Array | string,
            _options?: { encoding?: string; mode?: number }
        ): Promise<void> {
            const path = normalizePath(filepath);
            if (!path) {
                throw createFsError('EINVAL', 'Cannot write to root');
            }

            const bytes = typeof data === 'string'
                ? new TextEncoder().encode(data)
                : data;

            // Ensure parent directories exist
            const parts = path.split('/');
            if (parts.length > 1) {
                const parentParts = parts.slice(0, -1);
                try {
                    await getOpfsDirectory(parentParts, true);
                } catch (e) {
                    console.error('[opfs-git] Failed to create parent dirs:', parentParts, e);
                }
            }

            await asyncWriteFile(path, bytes);
        },

        async unlink(filepath: string): Promise<void> {
            const path = normalizePath(filepath);
            if (!path) {
                throw createFsError('EINVAL', 'Cannot unlink root');
            }

            const parts = path.split('/');
            const filename = parts.pop()!;

            try {
                const parentDir = parts.length > 0
                    ? await getOpfsDirectory(parts, false)
                    : getOpfsRoot();
                if (!parentDir) throw new Error('OPFS not initialized');
                await parentDir.removeEntry(filename);
            } catch (e) {
                console.error('[opfs-git] unlink failed:', path, e);
                throw createFsError('ENOENT', `ENOENT: no such file or directory, unlink '${filepath}'`);
            }
        },

        async readdir(dirpath: string): Promise<string[]> {
            const path = normalizePath(dirpath);
            try {
                const entries = await listDirectory(path);
                return entries.map(e => e.name);
            } catch {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, scandir '${dirpath}'`);
            }
        },

        async mkdir(dirpath: string, _options?: { recursive?: boolean }): Promise<void> {
            const path = normalizePath(dirpath);
            if (!path) return; // Don't create root

            const parts = path.split('/').filter(p => p);

            try {
                await getOpfsDirectory(parts, true); // create=true
            } catch (e) {
                console.error('[opfs-git] mkdir failed:', path, e);
                throw createFsError('ENOENT', `Failed to create directory '${dirpath}'`);
            }
        },

        async rmdir(dirpath: string): Promise<void> {
            const path = normalizePath(dirpath);
            if (!path) {
                throw createFsError('EINVAL', 'Cannot rmdir root');
            }

            const parts = path.split('/');
            const dirname = parts.pop()!;

            try {
                const parentDir = parts.length > 0
                    ? await getOpfsDirectory(parts, false)
                    : getOpfsRoot();
                if (!parentDir) throw new Error('OPFS not initialized');
                await parentDir.removeEntry(dirname, { recursive: true });
            } catch (e) {
                console.error('[opfs-git] rmdir failed:', path, e);
                throw createFsError('ENOENT', `ENOENT: no such directory, rmdir '${dirpath}'`);
            }
        },

        async stat(filepath: string): Promise<Stats> {
            const path = normalizePath(filepath);

            // Handle root
            if (!path || path === '/') {
                return createStats(true, 0, Date.now(), '/');
            }

            // Check if it's a file
            const isFile = await fileExistsInOpfs(path);
            if (isFile) {
                try {
                    const fileHandle = await getOpfsFile(path, false);
                    const file = await fileHandle.getFile();
                    return createStats(false, file.size, file.lastModified, path);
                } catch {
                    throw createFsError('ENOENT', `ENOENT: no such file or directory, stat '${filepath}'`);
                }
            }

            // Check if it's a directory
            const isDir = await directoryExistsInOpfs(path);
            if (isDir) {
                return createStats(true, 0, Date.now(), path);
            }

            throw createFsError('ENOENT', `ENOENT: no such file or directory, stat '${filepath}'`);
        },

        async lstat(filepath: string): Promise<Stats> {
            // Same as stat for now (symlinks not supported in OPFS)
            return this.stat(filepath);
        },

        async readlink(_filepath: string): Promise<string> {
            // OPFS doesn't support symlinks
            throw createFsError('EINVAL', 'Symlinks not supported in OPFS');
        },

        async symlink(_target: string, _filepath: string): Promise<void> {
            // OPFS doesn't support symlinks - silently ignore for git compatibility
            console.warn('[opfs-git] symlink not supported, ignoring');
        },

        async chmod(_filepath: string, _mode: number): Promise<void> {
            // No-op: OPFS doesn't support Unix permissions
        },

        async rename(oldPath: string, newPath: string): Promise<void> {
            const oldNorm = normalizePath(oldPath);
            const newNorm = normalizePath(newPath);

            if (!oldNorm || !newNorm) {
                throw createFsError('EINVAL', 'Invalid path for rename');
            }

            try {
                // Read old file
                const data = await asyncReadFile(oldNorm);

                // Write to new location
                await asyncWriteFile(newNorm, data);

                // Delete old file
                const parts = oldNorm.split('/');
                const filename = parts.pop()!;
                const parentDir = parts.length > 0
                    ? await getOpfsDirectory(parts, false)
                    : await getOpfsRoot();
                await parentDir.removeEntry(filename);
            } catch (e) {
                console.error('[opfs-git] rename failed:', oldPath, '->', newPath, e);
                throw createFsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}'`);
            }
        },
    },
};
