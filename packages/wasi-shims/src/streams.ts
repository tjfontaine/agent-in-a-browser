/**
 * Custom Stream Classes for WASI
 * 
 * Provides InputStream and OutputStream implementations that properly
 * return Pollable from subscribe().
 * 
 * IMPORTANT: ReadyPollable is imported from poll-impl.js where ALL Pollable
 * subclasses are defined in the same file, ensuring they all extend from
 * the same globalThis-registered base class.
 */

// Import ReadyPollable from poll-impl.ts (consolidated Pollable hierarchy)
import { ReadyPollable } from './poll-impl.js';

// Re-export for consumers
export { Pollable, ReadyPollable, DurationPollable, InstantPollable } from './poll-impl.js';

// Counter for unique IDs
let id = 0;

// Symbol for dispose
const symbolDispose = Symbol.dispose || Symbol.for('dispose');

// Symbol markers for patched instanceof checks (cross-bundle validation)
const INPUT_STREAM_MARKER = Symbol.for('wasi:io/streams@0.2.9#InputStream');
const OUTPUT_STREAM_MARKER = Symbol.for('wasi:io/streams@0.2.9#OutputStream');

/**
 * InputStreamHandler interface matching preview2-shim expectations
 */
export interface InputStreamHandler {
    read?: (len: bigint) => Uint8Array;
    blockingRead: (len: bigint) => Uint8Array | Promise<Uint8Array>;
    skip?: (len: bigint) => bigint;
    blockingSkip?: (len: bigint) => bigint;
    /** 
     * Optional subscribe that returns a Pollable for async-aware polling.
     * If not provided, subscribe() returns ReadyPollable (always ready).
     */
    subscribe?: () => ReadyPollable | void;
    drop?: () => void;
}

/**
 * OutputStreamHandler interface matching preview2-shim expectations
 */
export interface OutputStreamHandler {
    checkWrite?: () => bigint;
    write: (buf: Uint8Array) => bigint;
    blockingWriteAndFlush?: (buf: Uint8Array) => void;
    flush?: () => void;
    blockingFlush?: () => void;
    subscribe?: () => void;
    drop?: () => void;
}

/**
 * Custom InputStream that properly returns Pollable from subscribe().
 */
export class InputStream {
    id: number;
    handler: InputStreamHandler;

    constructor(handler: InputStreamHandler) {
        this.id = ++id;
        this.handler = handler;
        // Symbol marker for patched instanceof checks
        Object.defineProperty(this, INPUT_STREAM_MARKER, { value: true, enumerable: false });
    }

    read(len: bigint): Uint8Array {
        if (this.handler.read) {
            return this.handler.read(len);
        }
        const result = this.handler.blockingRead(len);
        if (result instanceof Promise) {
            throw new Error('blockingRead returned Promise in non-async context');
        }
        return result;
    }

    blockingRead(len: bigint): Uint8Array | Promise<Uint8Array> {
        console.log('[InputStream:class] blockingRead delegation called, len:', len.toString());
        return this.handler.blockingRead(len);
    }

    skip(len: bigint): bigint {
        if (this.handler.skip) {
            return this.handler.skip(len);
        }
        const bytes = this.read(len);
        return BigInt(bytes.byteLength);
    }

    blockingSkip(len: bigint): bigint {
        if (this.handler.blockingSkip) {
            return this.handler.blockingSkip(len);
        }
        const result = this.blockingRead(len);
        if (result instanceof Promise) {
            throw new Error('blockingRead returned Promise in non-async context');
        }
        return BigInt(result.byteLength);
    }

    subscribe(): ReadyPollable {
        // If handler provides a subscribe, use it (may return async-aware Pollable)
        if (this.handler.subscribe) {
            const pollable = this.handler.subscribe();
            if (pollable) {
                return pollable;
            }
        }
        // Default: always ready
        return new ReadyPollable();
    }

    [symbolDispose](): void {
        if (this.handler.drop) {
            this.handler.drop();
        }
    }
}

/**
 * Custom OutputStream that properly returns Pollable from subscribe().
 */
export class OutputStream {
    id: number;
    open: boolean;
    handler: OutputStreamHandler;

    constructor(handler: OutputStreamHandler) {
        this.id = ++id;
        this.open = true;
        this.handler = handler;
        // Symbol marker for patched instanceof checks
        Object.defineProperty(this, OUTPUT_STREAM_MARKER, { value: true, enumerable: false });
    }

    checkWrite(_len?: bigint): bigint {
        if (!this.open) {
            return 0n;
        }
        if (this.handler.checkWrite) {
            return this.handler.checkWrite();
        }
        return 1_000_000n;
    }

    write(buf: Uint8Array): bigint {
        return this.handler.write(buf);
    }

    blockingWriteAndFlush(buf: Uint8Array): void {
        if (this.handler.blockingWriteAndFlush) {
            this.handler.blockingWriteAndFlush(buf);
        } else {
            this.write(buf);
            this.flush();
        }
    }

    flush(): void {
        if (this.handler.flush) {
            this.handler.flush();
        }
    }

    blockingFlush(): void {
        if (this.handler.blockingFlush) {
            this.handler.blockingFlush();
        }
        this.open = true;
    }

    writeZeroes(len: bigint): void {
        this.write(new Uint8Array(Number(len)));
    }

    blockingWriteZeroes(len: bigint): void {
        this.blockingWriteAndFlush(new Uint8Array(Number(len)));
    }

    blockingWriteZeroesAndFlush(len: bigint): void {
        this.blockingWriteAndFlush(new Uint8Array(Number(len)));
    }

    splice(src: InputStream, len: bigint): bigint {
        const spliceLen = Number(len < this.checkWrite() ? len : this.checkWrite());
        const bytes = src.read(BigInt(spliceLen));
        this.write(bytes);
        return BigInt(bytes.byteLength);
    }

    blockingSplice(_src: InputStream, _len: bigint): bigint {
        console.log(`[streams] Blocking splice ${this.id}`);
        return 0n;
    }

    forward(_src: InputStream): void {
        console.log(`[streams] Forward ${this.id}`);
    }

    subscribe(): ReadyPollable {
        return new ReadyPollable();
    }

    [symbolDispose](): void {
        if (this.handler.drop) {
            this.handler.drop();
        }
    }
}

// Convenience aliases for backwards compatibility
export { InputStream as CustomInputStream };
export { OutputStream as CustomOutputStream };
