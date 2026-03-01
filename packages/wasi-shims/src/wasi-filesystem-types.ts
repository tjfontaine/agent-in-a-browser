/**
 * WASI Filesystem Type Interfaces
 *
 * Abstract interfaces for WASI Preview 2 filesystem implementations.
 * Allows different backends (OPFS, in-memory, etc.) to be plugged in.
 *
 * Interfaces use union return types (T | Promise<T>) to accommodate both
 * JSPI (async) and sync-worker (Atomics) execution modes.
 */

import type { InputStream, OutputStream } from './streams.js';

/**
 * WASI datetime format (seconds + nanoseconds)
 */
export interface WasiDatetime {
    seconds: bigint;
    nanoseconds: number;
}

/**
 * File/directory metadata returned by stat operations
 */
export interface WasiStat {
    type: 'directory' | 'regular-file' | 'symbolic-link' | 'unknown';
    linkCount: bigint;
    size: bigint;
    dataAccessTimestamp: WasiDatetime;
    dataModificationTimestamp: WasiDatetime;
    statusChangeTimestamp: WasiDatetime;
}

/**
 * Directory entry from readDirectory
 */
export interface DirectoryEntry {
    name: string;
    type: 'directory' | 'regular-file' | 'symbolic-link';
}

/**
 * Open flags for openAt
 */
export interface OpenFlags {
    create?: boolean;
    directory?: boolean;
    truncate?: boolean;
}

/**
 * Directory entry stream — iterates over entries returned by readDirectory
 */
export interface IDirectoryEntryStream {
    readDirectoryEntry(): DirectoryEntry | null;
}

/**
 * WASI Descriptor — represents an open file or directory.
 *
 * Methods return T | Promise<T> to support both sync (Atomics) and async (JSPI) modes.
 */
export interface IDescriptor {
    getType(): 'directory' | 'regular-file';

    stat(): WasiStat;
    statAt(pathFlags: number, subpath: string): WasiStat | Promise<WasiStat>;

    openAt(
        pathFlags: number,
        subpath: string,
        openFlags: OpenFlags,
        descriptorFlags: number,
        modes: number
    ): IDescriptor | Promise<IDescriptor>;

    createDirectoryAt(subpath: string): void | Promise<void>;

    read(length: number | bigint, offset: bigint): [Uint8Array, boolean] | Promise<[Uint8Array, boolean]>;
    readViaStream(offset: bigint): InputStream;

    write(buffer: Uint8Array, offset: bigint): number | Promise<number>;
    writeViaStream(offset: bigint): OutputStream;

    appendViaStream(): OutputStream;

    readDirectory(): IDirectoryEntryStream | Promise<IDirectoryEntryStream>;

    sync(): void;
    syncData(): void;

    setSize(size: bigint): void;

    readlinkAt(subpath: string): string;
    symlinkAt(oldPath: string, newPath: string): void | Promise<void>;

    removeDirectoryAt(subpath: string): void | Promise<void>;
    unlinkFileAt(subpath: string): void | Promise<void>;

    renameAt(
        oldPathFlags: number,
        oldPath: string,
        newDescriptor: IDescriptor,
        newPath: string
    ): void | Promise<void>;
}

/**
 * WASI Preopens — provides root directory descriptors
 */
export interface IPreopens {
    getDirectories(): Array<[IDescriptor, string]>;
}

/**
 * WASI Filesystem types — constructor exports for Descriptor and DirectoryEntryStream
 */
export interface IFilesystemTypes {
    Descriptor: new (...args: unknown[]) => IDescriptor;
    DirectoryEntryStream: new (...args: unknown[]) => IDirectoryEntryStream;
    filesystemErrorCode: () => string | undefined;
}

/**
 * Complete WASI Filesystem interface
 */
export interface WasiFilesystem {
    initFilesystem(): Promise<void>;
    preopens: IPreopens;
    types: IFilesystemTypes;
    prepareFileForSync(path: string): Promise<void>;
    releaseFile(path: string): void;
    _setCwd(path: string): void;
    _getCwd(): string;
}
