/**
 * OPFS Adapter for isomorphic-git
 *
 * This module provides a `fs` interface compatible with isomorphic-git
 * that uses our OPFS-backed filesystem. This allows git operations
 * to use the same storage as the rest of the shell.
 *
 * All operations go directly to OPFS, not in-memory tree.
 */
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
/**
 * OPFS-backed filesystem for isomorphic-git
 * All operations go directly to OPFS, no in-memory caching.
 */
export declare const opfsFs: {
    promises: {
        readFile(filepath: string, options?: {
            encoding?: string;
        } | string): Promise<Uint8Array | string>;
        writeFile(filepath: string, data: Uint8Array | string, _options?: {
            encoding?: string;
            mode?: number;
        }): Promise<void>;
        unlink(filepath: string): Promise<void>;
        readdir(dirpath: string): Promise<string[]>;
        mkdir(dirpath: string, _options?: {
            recursive?: boolean;
        }): Promise<void>;
        rmdir(dirpath: string): Promise<void>;
        stat(filepath: string): Promise<Stats>;
        lstat(filepath: string): Promise<Stats>;
        readlink(_filepath: string): Promise<string>;
        symlink(_target: string, _filepath: string): Promise<void>;
        chmod(_filepath: string, _mode: number): Promise<void>;
        rename(oldPath: string, newPath: string): Promise<void>;
    };
};
//# sourceMappingURL=opfs-git-adapter.d.ts.map