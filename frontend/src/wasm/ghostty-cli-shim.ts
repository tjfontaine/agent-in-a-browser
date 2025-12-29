/**
 * Custom CLI shims for TUI WASM that bridge to ghostty-web
 * 
 * This module provides WASI CLI stdin/stdout implementations that
 * connect to a ghostty-web terminal instead of the default shims.
 */

import type { Terminal } from 'ghostty-web';

// Buffer for stdin data from terminal
const stdinBuffer: Uint8Array[] = [];
const stdinWaiters: Array<(data: Uint8Array) => void> = [];

// Terminal reference
let currentTerminal: Terminal | null = null;

/**
 * Set the terminal that will be used for stdin/stdout
 */
export function setTerminal(terminal: Terminal): void {
    currentTerminal = terminal;

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
 * Read from stdin (blocking)
 */
async function readStdin(len: number): Promise<Uint8Array> {
    // Check if we have buffered data
    if (stdinBuffer.length > 0) {
        const chunk = stdinBuffer.shift()!;
        if (chunk.length <= len) {
            return chunk;
        }
        // Split the chunk
        const result = chunk.slice(0, len);
        stdinBuffer.unshift(chunk.slice(len));
        return result;
    }

    // Wait for data
    return new Promise(resolve => {
        stdinWaiters.push(resolve);
    });
}

/**
 * InputStream implementation for ghostty-web stdin
 */
class GhosttyInputStream {
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
    }

    async blockingRead(len: bigint): Promise<Uint8Array> {
        return await readStdin(Number(len));
    }

    skip(len: bigint): bigint {
        const data = this.read(len);
        return BigInt(data.length);
    }

    async blockingSkip(len: bigint): Promise<bigint> {
        const data = await this.blockingRead(len);
        return BigInt(data.length);
    }

    subscribe() {
        return {
            ready: () => stdinBuffer.length > 0,
            block: () => { /* Can't block in browser */ }
        };
    }

    [Symbol.dispose ?? Symbol.for('dispose')]() { }
}

/**
 * OutputStream implementation for ghostty-web stdout
 */
class GhosttyOutputStream {
    checkWrite(): bigint {
        return BigInt(1024 * 1024); // Always ready
    }

    write(contents: Uint8Array): void {
        if (currentTerminal) {
            currentTerminal.write(new TextDecoder().decode(contents));
        }
    }

    async blockingWriteAndFlush(contents: Uint8Array): Promise<void> {
        this.write(contents);
    }

    flush(): void { }

    async blockingFlush(): Promise<void> { }

    subscribe() {
        return {
            ready: () => true,
            block: () => { }
        };
    }

    splice(_src: unknown, _len: bigint): bigint {
        throw new Error('splice not implemented');
    }

    async blockingSplice(_src: unknown, _len: bigint): Promise<bigint> {
        throw new Error('blockingSplice not implemented');
    }

    writeZeroes(len: bigint): void {
        this.write(new Uint8Array(Number(len)));
    }

    async blockingWriteZeroes(len: bigint): Promise<void> {
        this.writeZeroes(len);
    }

    [Symbol.dispose ?? Symbol.for('dispose')]() { }
}

// Singleton instances
let stdinStream: GhosttyInputStream | null = null;
let stdoutStream: GhosttyOutputStream | null = null;
let stderrStream: GhosttyOutputStream | null = null;

/**
 * Get stdin stream
 */
export function getStdin() {
    if (!stdinStream) {
        stdinStream = new GhosttyInputStream();
    }
    return stdinStream;
}

/**
 * Get stdout stream
 */
export function getStdout() {
    if (!stdoutStream) {
        stdoutStream = new GhosttyOutputStream();
    }
    return stdoutStream;
}

/**
 * Get stderr stream
 */
export function getStderr() {
    if (!stderrStream) {
        stderrStream = new GhosttyOutputStream();
    }
    return stderrStream;
}

// Export the shim interface compatible with @bytecodealliance/preview2-shim/cli
export const stdin = { getStdin };
export const stdout = { getStdout };
export const stderr = { getStderr };

// Environment stub
export const environment = {
    getEnvironment: () => [] as [string, string][],
};

// Exit stub
export const exit = {
    exit: (code: { tag: string; val?: number }) => {
        console.log('TUI exit:', code);
    }
};

// Terminal stubs (for raw mode, etc.)
export const terminalInput = {
    TerminalInput: class { },
};

export const terminalOutput = {
    TerminalOutput: class { },
};

export const terminalStdin = {
    getTerminalStdin: () => null,
};

export const terminalStdout = {
    getTerminalStdout: () => null,
};

export const terminalStderr = {
    getTerminalStderr: () => null,
};
