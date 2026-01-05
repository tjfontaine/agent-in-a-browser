// Global type definitions for missing browser APIs

// OPFS Sync Handle
interface FileSystemSyncAccessHandle {
    read(buffer: ArrayBuffer | ArrayBufferView, options?: { at: number }): number;
    write(buffer: ArrayBuffer | ArrayBufferView, options?: { at: number }): number;
    flush(): void;
    getSize(): number;
    truncate(newSize: number): void;
    close(): void;
}

interface FileSystemFileHandle {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

// WorkerGlobalScope
declare var WorkerGlobalScope: {
    prototype: WorkerGlobalScope;
    new(): WorkerGlobalScope;
};

interface WorkerGlobalScope extends EventTarget, WindowOrWorkerGlobalScope {
}

// Symbol.dispose polyfill for TypeScript
interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
}
