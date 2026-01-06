/**
 * Shared Constants for Worker/Main Thread Communication
 * 
 * These constants define the SharedArrayBuffer layout for
 * Atomics-based synchronization between the WASM worker and main thread.
 * 
 * Extracted to avoid circular dependencies with wasm-worker.ts which
 * has cross-package imports that break standalone tsc compilation.
 */

// Control array layout for stdin operations
export const STDIN_CONTROL = {
    REQUEST_READY: 0,    // Worker signals it wants input
    RESPONSE_READY: 1,   // Main thread signals input available
    DATA_LENGTH: 2,      // Length of data in buffer
    EOF: 3,              // End of input stream
};

// Control array layout for HTTP operations (separate region)
export const HTTP_CONTROL = {
    REQUEST_READY: 4,    // Worker signals HTTP request
    RESPONSE_READY: 5,   // Main thread signals response ready
    STATUS_CODE: 6,      // HTTP status code
    BODY_LENGTH: 7,      // Length of body chunk
    DONE: 8,             // Response complete
};

// Buffer layout
export const BUFFER_LAYOUT = {
    CONTROL_SIZE: 64,           // 16 int32s
    STDIN_BUFFER_OFFSET: 64,    // After control
    STDIN_BUFFER_SIZE: 4096,    // 4KB for stdin
    HTTP_BUFFER_OFFSET: 64 + 4096,
    HTTP_BUFFER_SIZE: 60 * 1024, // ~60KB for HTTP
};

// Message types for worker communication
export interface WorkerInitMessage {
    type: 'init';
    sharedBuffer: SharedArrayBuffer;
}

export interface WorkerRunMessage {
    type: 'run';
    module: 'tui' | 'mcp';
    args?: string[];
}

export interface WorkerInputMessage {
    type: 'stdin';
    data: Uint8Array;
}

export interface WorkerHttpResponseMessage {
    type: 'http-response';
    status: number;
    headers: [string, string][];
    bodyChunk: Uint8Array;
    done: boolean;
}

export interface WorkerResizeMessage {
    type: 'resize';
    cols: number;
    rows: number;
}

export type WorkerMessage =
    | WorkerInitMessage
    | WorkerRunMessage
    | WorkerInputMessage
    | WorkerHttpResponseMessage
    | WorkerResizeMessage;
