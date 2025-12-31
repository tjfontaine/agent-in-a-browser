/**
 * WASI Filesystem Interface
 * 
 * Abstract interface for WASI filesystem implementations.
 * This allows different backends (OPFS, in-memory, etc.) to be plugged in.
 */

/**
 * WASI datetime format
 */
export interface WasiDatetime {
    seconds: bigint;
    nanoseconds: number;
}

/**
 * File/directory metadata
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
 * Directory entry stream interface
 */
export interface IDirectoryEntryStream {
    readDirectoryEntry(): DirectoryEntry | null;
}

/**
 * WASI Descriptor interface - represents an open file or directory
 */
export interface IDescriptor {
    /** Get the type of this descriptor */
    getType(): 'directory' | 'regular-file';

    /** Get file/directory stats */
    stat(): WasiStat;

    /** Get stats for a path relative to this descriptor */
    statAt(pathFlags: number, subpath: string): Promise<WasiStat>;

    /** Open a file/directory relative to this descriptor */
    openAt(
        pathFlags: number,
        subpath: string,
        openFlags: OpenFlags,
        descriptorFlags: number,
        modes: number
    ): Promise<IDescriptor>;

    /** Create a directory */
    createDirectoryAt(subpath: string): Promise<void>;

    /** Read file content */
    read(length: number, offset: bigint): [Uint8Array, boolean];

    /** Read file content via stream */
    readViaStream(offset: bigint): unknown;

    /** Write file content */
    write(buffer: Uint8Array, offset: bigint): number;

    /** Write file content via stream */
    writeViaStream(offset: bigint): unknown;

    /** Append to file via stream */
    appendViaStream(): unknown;

    /** Read directory entries */
    readDirectory(): Promise<IDirectoryEntryStream>;

    /** Sync file data to storage */
    sync(): void;

    /** Sync file data */
    syncData(): void;

    /** Set file size (truncate or extend) */
    setSize(size: bigint): void;

    /** Read symbolic link target */
    readlinkAt(subpath: string): string;

    /** Create symbolic link */
    symlinkAt(oldPath: string, newPath: string): Promise<void>;

    /** Remove directory */
    removeDirectoryAt(subpath: string): Promise<void>;

    /** Remove file */
    unlinkFileAt(subpath: string): Promise<void>;

    /** Rename file/directory */
    renameAt(
        oldPathFlags: number,
        oldPath: string,
        newDescriptor: IDescriptor,
        newPath: string
    ): Promise<void>;
}

/**
 * WASI Preopens interface
 */
export interface IPreopens {
    getDirectories(): Array<[IDescriptor, string]>;
}

/**
 * WASI Filesystem types interface
 */
export interface IFilesystemTypes {
    Descriptor: new (...args: unknown[]) => IDescriptor;
    DirectoryEntryStream: new (...args: unknown[]) => IDirectoryEntryStream;
    filesystemErrorCode: () => string | undefined;
}

/**
 * Complete WASI Filesystem interface
 * 
 * Implements the wasi:filesystem interface for browser environments.
 */
export interface WasiFilesystem {
    /** Initialize the filesystem */
    initFilesystem(): Promise<void>;

    /** Preopened directories */
    preopens: IPreopens;

    /** Filesystem types (Descriptor, DirectoryEntryStream, etc.) */
    types: IFilesystemTypes;

    /** Prepare a file for synchronous access */
    prepareFileForSync(path: string): Promise<void>;

    /** Release a file's sync handle */
    releaseFile(path: string): void;

    /** Set current working directory */
    _setCwd(path: string): void;

    /** Get current working directory */
    _getCwd(): string;
}
