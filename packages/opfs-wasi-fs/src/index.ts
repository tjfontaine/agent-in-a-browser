/**
 * @tjfontaine/opfs-wasi-fs
 * 
 * WASI filesystem implementation backed by OPFS (Origin Private File System).
 * 
 * This package provides a browser-compatible filesystem implementation that
 * conforms to the WASI Preview 2 filesystem interface.
 */

// Export the interface
export type {
    WasiFilesystem,
    WasiDatetime,
    WasiStat,
    DirectoryEntry,
    OpenFlags,
    IDescriptor,
    IDirectoryEntryStream,
    IPreopens,
    IFilesystemTypes,
} from './WasiFilesystem';

// Export the OPFS implementation
export {
    initFilesystem,
    preopens,
    types,
    filesystemTypes,
    prepareFileForSync,
    releaseFile,
    _setCwd,
    _getCwd,
} from './OpfsFilesystem';

// Export stream classes for consumers
export { InputStream, OutputStream } from './streams';

// Export utility functions that may be useful
export {
    normalizePath,
    resolveSymlinks,
    getCwd,
    setCwd,
} from './directory-tree';
