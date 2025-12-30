/**
 * OPFS Adapter for isomorphic-git
 *
 * This module provides a `fs` interface compatible with isomorphic-git
 * that uses our OPFS-backed filesystem. This allows git operations
 * to use the same storage as the rest of the shell.
 */

import {
    getTreeEntry,
    setTreeEntry,
    removeTreeEntry,
    normalizePath,
    getEntryFromOpfs,
    listDirectory,
    type TreeEntry,
} from './directory-tree';
import { syncReadFileBinary, syncWriteFileBinary } from './opfs-sync-bridge';

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

function createStats(entry: TreeEntry, path: string): Stats {
    const isDir = entry.dir !== undefined;
    const isSymlink = entry.symlink !== undefined;
    const type = isDir ? 'dir' : isSymlink ? 'symlink' : 'file';
    const size = entry.size ?? 0;
    const mtime = entry.mtime ?? Date.now();

    return {
        type,
        mode: isDir ? 0o40755 : 0o100644,
        size,
        ino: hashPath(path),
        mtimeMs: mtime,
        ctimeMs: mtime,
        uid: 1000,
        gid: 1000,
        dev: 1,
        isFile: () => !isDir && !isSymlink,
        isDirectory: () => isDir,
        isSymbolicLink: () => isSymlink,
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
 */
export const opfsFs = {
    promises: {
        async readFile(
            filepath: string,
            options?: { encoding?: string } | string
        ): Promise<Uint8Array | string> {
            const path = normalizePath(filepath);
            const data = syncReadFileBinary(path);
            if (!data) {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, open '${filepath}'`);
            }

            const encoding = typeof options === 'string' ? options : options?.encoding;
            if (encoding === 'utf8' || encoding === 'utf-8') {
                return new TextDecoder().decode(data);
            }
            return data;
        },

        async writeFile(
            filepath: string,
            data: Uint8Array | string,
            _options?: { encoding?: string; mode?: number }
        ): Promise<void> {
            const path = normalizePath(filepath);
            const bytes = typeof data === 'string'
                ? new TextEncoder().encode(data)
                : data;

            syncWriteFileBinary(path, bytes);
            setTreeEntry(path, { size: bytes.length, mtime: Date.now() });
        },

        async unlink(filepath: string): Promise<void> {
            const path = normalizePath(filepath);
            removeTreeEntry(path);
            // TODO: Also remove from OPFS
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
            const parts = path.split('/').filter(p => p);

            let current = '';
            for (const part of parts) {
                current = current ? `${current}/${part}` : part;
                const existing = getTreeEntry(current);
                if (!existing) {
                    setTreeEntry(current, { dir: {}, mtime: Date.now() });
                }
            }
        },

        async rmdir(dirpath: string): Promise<void> {
            const path = normalizePath(dirpath);
            removeTreeEntry(path);
        },

        async stat(filepath: string): Promise<Stats> {
            const path = normalizePath(filepath);
            // Get entry from OPFS directly
            const entry = await getEntryFromOpfs(path);
            if (!entry) {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, stat '${filepath}'`);
            }
            return createStats(entry, path || '/');
        },

        async lstat(filepath: string): Promise<Stats> {
            // Same as stat for now (symlinks not fully implemented)
            return this.stat(filepath);
        },

        async readlink(filepath: string): Promise<string> {
            const path = normalizePath(filepath);
            const entry = getTreeEntry(path);
            if (!entry?.symlink) {
                throw createFsError('EINVAL', `EINVAL: invalid argument, readlink '${filepath}'`);
            }
            return entry.symlink;
        },

        async symlink(target: string, filepath: string): Promise<void> {
            const path = normalizePath(filepath);
            setTreeEntry(path, { symlink: target, mtime: Date.now() });
        },

        async chmod(_filepath: string, _mode: number): Promise<void> {
            // No-op: OPFS doesn't support Unix permissions
        },

        async rename(oldPath: string, newPath: string): Promise<void> {
            const oldNorm = normalizePath(oldPath);
            const newNorm = normalizePath(newPath);
            const entry = getTreeEntry(oldNorm);
            if (!entry) {
                throw createFsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}'`);
            }
            setTreeEntry(newNorm, entry);
            removeTreeEntry(oldNorm);
        },
    },
};
