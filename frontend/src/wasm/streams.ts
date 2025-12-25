/**
 * Custom Stream Classes for WASI
 * 
 * Provides InputStream and OutputStream implementations that properly
 * return Pollable from subscribe(), fixing bugs in the preview2-shim.
 */

import { streams, poll } from '@bytecodealliance/preview2-shim/io';

// Get base classes from preview2-shim for inheritance
// @ts-expect-error - preview2-shim exports this as type-only but it's a runtime value
const { InputStream: BaseInputStream, OutputStream: BaseOutputStream } = streams as unknown as {
    InputStream: new (config: unknown) => { id: number; handler: unknown };
    OutputStream: new (config: unknown) => { id: number; handler: unknown };
};

// Get the Pollable class from the io shim
// @ts-expect-error - Pollable is exported at runtime
const { Pollable: BasePollable } = poll as { Pollable: new () => { ready(): boolean; block(): void } };

/**
 * A Pollable that is always ready.
 * Used for stream subscribe() since our streams are synchronously readable.
 */
export class ReadyPollable extends BasePollable {
    ready(): boolean {
        return true;
    }

    block(): void {
        // Already ready, nothing to block on
    }
}

// Symbol for dispose
const symbolDispose = Symbol.dispose || Symbol.for('dispose');

/**
 * Custom InputStream that properly returns Pollable from subscribe().
 * The preview2-shim's InputStream.subscribe() returns undefined, breaking WASM.
 */
export class CustomInputStream extends BaseInputStream {
    constructor(handler: {
        read?: (len: bigint) => Uint8Array;
        blockingRead: (len: bigint) => Uint8Array;
    }) {
        super(handler);
    }

    subscribe(): ReadyPollable {
        return new ReadyPollable();
    }

    [symbolDispose](): void {
        // Cleanup if needed
    }
}

/**
 * Custom OutputStream that properly returns Pollable from subscribe().
 */
export class CustomOutputStream extends BaseOutputStream {
    constructor(handler: {
        write: (buf: Uint8Array) => bigint;
        blockingWriteAndFlush?: (buf: Uint8Array) => void;
        flush?: () => void;
        blockingFlush?: () => void;
        checkWrite?: () => bigint;
    }) {
        super(handler);
    }

    subscribe(): ReadyPollable {
        return new ReadyPollable();
    }

    [symbolDispose](): void {
        // Cleanup if needed
    }
}

// Convenience re-exports
export const InputStream = CustomInputStream;
export const OutputStream = CustomOutputStream;
