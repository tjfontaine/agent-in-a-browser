/**
 * WASM Module Index
 * 
 * Exports all WASM-related modules for easy importing.
 * The modules are organized as follows:
 * 
 * - streams.ts: Custom WASI stream classes (InputStream, OutputStream, ReadyPollable)
 * - opfs-sync-bridge.ts: Synchronous OPFS operations via SharedArrayBuffer
 * - directory-tree.ts: In-memory directory tree management
 * - opfs-filesystem-impl.ts: Main WASI filesystem implementation (Descriptor, preopens)
 * - opfs-async-helper.ts: Worker for async OPFS operations
 * - wasi-http-impl.ts: WASI HTTP implementation
 */

// Stream classes
export {
    ReadyPollable,
    CustomInputStream,
    CustomOutputStream,
    InputStream,
    OutputStream,
} from './streams';

// Sync operations via helper worker
export {
    syncFileOperation,
    syncReadFile,
    syncWriteFile,
    syncExists,
    syncStat,
    syncMkdir,
    syncRmdir,
    syncUnlink,
    initHelperWorker,
    isHelperReady,
    type SyncFileRequest,
    type SyncFileResponse,
    msToDatetime,
} from './opfs-sync-bridge';

// Directory tree management
export {
    directoryTree,
    syncHandleCache,
    getTreeEntry,
    setTreeEntry,
    removeTreeEntry,
    normalizePath,
    getOpfsDirectory,
    getOpfsFile,
    closeHandlesUnderPath,
    setCwd,
    getCwd,
    syncScanDirectory,
    type TreeEntry,
} from './directory-tree';

// Main WASI filesystem (re-export for backward compatibility)
export {
    initFilesystem,
    preopens,
    types,
    filesystemTypes,
    prepareFileForSync,
    releaseFile,
    _setCwd,
    _getCwd,
} from './opfs-filesystem-impl';
