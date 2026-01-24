/**
 * Custom CLI shims for TUI WASM that bridge to ghostty-web
 * 
 * This module provides WASI CLI stdin/stdout implementations that
 * connect to a ghostty-web terminal instead of the default shims.
 */

import type { Terminal } from 'ghostty-web';

// Use our existing custom stream classes that properly integrate with jco
import { CustomInputStream, CustomOutputStream } from './streams.js';

// Import terminal context for isatty detection
import { isTerminalContext } from '@tjfontaine/wasm-loader';

// Import execution mode detection and sync bridge
import { isSyncWorkerMode } from './execution-mode.js';
import { blockingReadStdin as syncBlockingRead } from './stdin-sync-bridge.js';

// Buffer for stdin data from terminal
const stdinBuffer: Uint8Array[] = [];
const stdinWaiters: Array<(data: Uint8Array) => void> = [];

// Terminal reference
let currentTerminal: Terminal | null = null;

// Terminal size (updated on resize)
let terminalCols = 80;
let terminalRows = 24;

// Piped mode streams - override default terminal streams for buffered command output
// When set, console.log/stdout goes to these callbacks instead of terminal
let pipedStdoutWrite: ((contents: Uint8Array) => bigint) | null = null;
let pipedStderrWrite: ((contents: Uint8Array) => bigint) | null = null;

// Debug mode callback key (globalThis for cross-bundle sharing)
// Uses globalThis to ensure all module instances share the same callback,
// even when bundled/transpiled separately
const DEBUG_STDERR_CALLBACK_KEY = Symbol.for('wasi-shims:debug-stderr-callback');

// Type for the callback
type DebugStderrCallback = ((text: string) => void) | null;

// Getter for the shared callback
function getDebugStderrCallback(): DebugStderrCallback {
    return (globalThis as Record<symbol, DebugStderrCallback>)[DEBUG_STDERR_CALLBACK_KEY] ?? null;
}

/**
 * Set piped write functions for buffered command output.
 * Call this before spawning a command that should capture stdout.
 * Call clearPipedStreams() after command completes.
 */
export function setPipedStreams(
    stdoutWrite: ((contents: Uint8Array) => bigint) | null,
    stderrWrite: ((contents: Uint8Array) => bigint) | null,
): void {
    pipedStdoutWrite = stdoutWrite;
    pipedStderrWrite = stderrWrite;
}

/**
 * Clear piped streams to restore normal terminal mode.
 */
export function clearPipedStreams(): void {
    pipedStdoutWrite = null;
    pipedStderrWrite = null;
}

/**
 * Set debug stderr callback for forwarding stderr to main thread.
 * Used when ?debug=true is set to show WASM stderr in browser DevTools.
 * Uses globalThis to share across bundled module instances.
 */
export function setDebugStderrCallback(callback: ((text: string) => void) | null): void {
    (globalThis as Record<symbol, DebugStderrCallback>)[DEBUG_STDERR_CALLBACK_KEY] = callback;
}

/**
 * Set the terminal that will be used for stdin/stdout
 */
export function setTerminal(terminal: Terminal): void {
    currentTerminal = terminal;

    // Set initial size from terminal
    terminalCols = terminal.cols;
    terminalRows = terminal.rows;

    // Wire terminal input → stdin buffer
    terminal.onData((data: string) => {
        const bytes = new TextEncoder().encode(data);
        if (stdinWaiters.length > 0) {
            // Someone is waiting for data
            const waiter = stdinWaiters.shift()!;
            waiter(bytes);
        } else {
            // Buffer the data
            stdinBuffer.push(bytes);
        }
    });
}

/**
 * Set terminal size (called on resize)
 */
export function setTerminalSize(cols: number, rows: number): void {
    terminalCols = cols;
    terminalRows = rows;

    // Send resize escape sequence to stdin
    // CSI 8 ; rows ; cols t (DECSLPP - Set terminal size)
    // But for simplicity, inject a special sequence the TUI can detect
    const resizeSequence = `\x1b[8;${rows};${cols}t`;
    const bytes = new TextEncoder().encode(resizeSequence);

    if (stdinWaiters.length > 0) {
        const waiter = stdinWaiters.shift()!;
        waiter(bytes);
    } else {
        stdinBuffer.push(bytes);
    }
}

/**
 * Get current terminal dimensions
 */
export function getTerminalSize(): { cols: number; rows: number } {
    return { cols: terminalCols, rows: terminalRows };
}

/**
 * Read from stdin (blocking) - async for JSPI
 * 
 * IMPORTANT: To support both single-keystroke echo and paste operations:
 * - First read when buffer is empty: BLOCKS until data arrives
 * - Subsequent reads with empty buffer: returns empty immediately (non-blocking)
 * 
 * This allows the Rust loop to drain all pasted data, then return to render.
 */
let hasDataBeenDelivered = false; // Tracks if we're mid-sequence

async function readStdin(len: number): Promise<Uint8Array> {
    // Check if we have buffered data
    if (stdinBuffer.length > 0) {
        const chunk = stdinBuffer.shift()!;
        hasDataBeenDelivered = true;
        if (chunk.length <= len) {
            return chunk;
        }
        // Split the chunk
        const result = chunk.slice(0, len);
        stdinBuffer.unshift(chunk.slice(len));
        return result;
    }

    // Buffer is empty - check if we already delivered data this sequence
    if (hasDataBeenDelivered) {
        // Already delivered data, return empty to let render loop continue
        hasDataBeenDelivered = false;
        return new Uint8Array(0);
    }

    // Wait for data - this suspends the WASM via JSPI
    const data = await new Promise<Uint8Array>(resolve => {
        stdinWaiters.push(resolve);
    });

    hasDataBeenDelivered = true;

    // Split the received data if it's larger than requested
    if (data.length <= len) {
        return data;
    }
    // Put the rest back in the buffer
    stdinBuffer.unshift(data.slice(len));
    return data.slice(0, len);
}

// Create stdin stream using our CustomInputStream
const stdinStream = new CustomInputStream({
    read(len: bigint): Uint8Array {
        // Non-blocking read - return empty if no data
        if (stdinBuffer.length === 0) {
            return new Uint8Array(0);
        }
        const chunk = stdinBuffer.shift()!;
        const n = Number(len);
        if (chunk.length <= n) {
            return chunk;
        }
        stdinBuffer.unshift(chunk.slice(n));
        return chunk.slice(0, n);
    },

    // blockingRead: supports both JSPI (async) and sync (worker) modes
    blockingRead(len: bigint): Uint8Array | Promise<Uint8Array> {
        // In sync-worker mode (Safari), use synchronous blocking via Atomics
        if (isSyncWorkerMode()) {
            return syncBlockingRead(Number(len));
        }
        // In JSPI mode (Chrome/Firefox), use async suspension
        return readStdin(Number(len));
    },
});

// Text decoder for output
const textDecoder = new TextDecoder();

// Helper: Convert bare LF to CRLF for proper terminal display
function convertToCrlf(text: string): string {
    // First normalize all line endings to LF, then convert to CRLF
    return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

// Create stdout stream using our CustomOutputStream
const stdoutStream = new CustomOutputStream({
    write(contents: Uint8Array): bigint {
        if (contents.length === 0) {
            return BigInt(0);
        }

        // Check for piped mode first - route to buffer instead of terminal
        if (pipedStdoutWrite) {
            return pipedStdoutWrite(contents);
        }

        try {
            const text = textDecoder.decode(contents);
            if (text.length === 0) {
                return BigInt(contents.length);
            }

            // Check if we're in the main thread with direct terminal access
            if (currentTerminal) {
                // Direct write to ghostty terminal (JSPI mode)
                currentTerminal.write(convertToCrlf(text));
            } else if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
                // WasmWorker context (Safari sync mode) - route via postMessage to main thread
                self.postMessage({
                    type: 'terminal-output',
                    data: convertToCrlf(text)
                });
            } else {
                // Fallback: log to console
                console.log('[stdout] Console fallback:', text);
            }
        } catch (e) {
            console.error('[ghostty-shim] Terminal write error:', e);
        }
        return BigInt(contents.length);
    },

    blockingFlush(): void { },
});

// Create stderr stream (goes to console.log only to avoid corrupting TUI)
const stderrStream = new CustomOutputStream({
    write(contents: Uint8Array): bigint {
        if (contents.length === 0) {
            return BigInt(0);
        }

        // Check for piped mode first - route to buffer instead of console
        if (pipedStderrWrite) {
            return pipedStderrWrite(contents);
        }

        try {
            const text = textDecoder.decode(contents);
            // Skip empty writes
            if (text.length > 0) {
                // Log to browser console for debugging WASM output
                // Note: We intentionally don't write to terminal to avoid corrupting the TUI
                console.log('[WASM stderr]', text.trimEnd());

                // Forward to main thread via debug callback if set (uses globalThis for cross-bundle sharing)
                const debugCallback = getDebugStderrCallback();
                if (debugCallback) {
                    debugCallback(text.trimEnd());
                }
            }
        } catch (e) {
            console.error('[ghostty-shim] Terminal stderr write error:', e);
        }
        return BigInt(contents.length);
    },

    // Called by WASM stderr for blocking writes (eprintln!, panic!, etc.)
    // This must call write() to trigger the debug callback forwarding
    blockingWriteAndFlush(contents: Uint8Array): void {
        this.write(contents);
    },

    blockingFlush(): void { },
});

// Export the shim interface compatible with @bytecodealliance/preview2-shim/cli
export const stdin = {
    getStdin: () => stdinStream
};

export const stdout = {
    getStdout: () => stdoutStream
};

export const stderr = {
    getStderr: () => stderrStream
};

// Environment stub
export const environment = {
    getEnvironment: () => [] as [string, string][],
    getArguments: () => [] as string[],
    initialCwd: () => '/',
};

// Exit stub
class ComponentExit extends Error {
    exitError = true;
    code: number;
    constructor(code: number) {
        super(`Component exited ${code === 0 ? 'successfully' : 'with error'}`);
        this.code = code;
    }
}

export const exit = {
    exit: (status: { tag: string; val?: number }) => {
        throw new ComponentExit(status.tag === 'err' ? 1 : 0);
    },
    exitWithCode: (code: number) => {
        throw new ComponentExit(code);
    }
};

// Terminal stubs (for raw mode, etc.)
class TerminalInput { }
class TerminalOutput { }

const terminalStdinInstance = new TerminalInput();
const terminalStdoutInstance = new TerminalOutput();
const terminalStderrInstance = new TerminalOutput();

export const terminalInput = {
    TerminalInput,
};

export const terminalOutput = {
    TerminalOutput,
};

export const terminalStdin = {
    TerminalInput,
    getTerminalStdin: () => isTerminalContext() ? terminalStdinInstance : undefined,
};

export const terminalStdout = {
    TerminalOutput,
    getTerminalStdout: () => isTerminalContext() ? terminalStdoutInstance : undefined,
};

export const terminalStderr = {
    TerminalOutput,
    getTerminalStderr: () => isTerminalContext() ? terminalStderrInstance : undefined,
};

// Export terminal size interface for terminal:info/size
export const size = {
    getTerminalSize: () => ({ cols: terminalCols, rows: terminalRows }),
};
