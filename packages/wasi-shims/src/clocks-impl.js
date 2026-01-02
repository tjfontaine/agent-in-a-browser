/* global performance, console */
/**
 * Custom WASI clocks implementation for browser environments.
 * 
 * This provides proper implementations of monotonic-clock and wall-clock
 * that work with the jco preview2-shim's Pollable class.
 * 
 * The key insight is that we need to:
 * 1. Import the Pollable class from the io shim
 * 2. Create subclasses that implement block() with proper timing
 */

import { poll } from '@bytecodealliance/preview2-shim/io';

// Get the Pollable class from the io shim
const { Pollable: BasePollable } = poll;

/**
 * A Pollable that becomes ready after a duration has elapsed.
 * Uses busy-wait since we're in a synchronous WASM context.
 */
class DurationPollable extends BasePollable {
    #targetTime;

    constructor(durationNanos) {
        super();
        // performance.now() is in milliseconds, convert to nanoseconds
        const nowNanos = BigInt(Math.floor(performance.now() * 1e6));
        this.#targetTime = nowNanos + BigInt(durationNanos);
    }

    ready() {
        const nowNanos = BigInt(Math.floor(performance.now() * 1e6));
        return nowNanos >= this.#targetTime;
    }

    block() {
        // Busy-wait until the target time is reached
        // This is necessary for synchronous WASM contexts
        while (!this.ready()) {
            // Busy wait - the loop will exit once enough time has passed
        }
    }
}

/**
 * A Pollable that becomes ready at a specific instant.
 */
class InstantPollable extends BasePollable {
    #targetTime;

    constructor(instantNanos) {
        super();
        this.#targetTime = BigInt(instantNanos);
    }

    ready() {
        const nowNanos = BigInt(Math.floor(performance.now() * 1e6));
        return nowNanos >= this.#targetTime;
    }

    block() {
        while (!this.ready()) {
            // Busy wait
        }
    }
}

export const monotonicClock = {
    resolution() {
        // Browser performance.now() typically has ~1ms resolution
        // Return in nanoseconds
        return 1_000_000n;
    },

    now() {
        // performance.now() is in milliseconds, convert to nanoseconds
        return BigInt(Math.floor(performance.now() * 1e6));
    },

    subscribeInstant(instant) {
        console.log(`[monotonic-clock] subscribeInstant: ${instant}`);
        return new InstantPollable(instant);
    },

    subscribeDuration(duration) {
        const durationNanos = BigInt(duration);
        return new DurationPollable(durationNanos);
    }
};

export const wallClock = {
    now() {
        const now = Date.now(); // in milliseconds since epoch
        const seconds = BigInt(Math.floor(now / 1000));
        const nanoseconds = (now % 1000) * 1_000_000;
        return { seconds, nanoseconds };
    },

    resolution() {
        // ~1ms resolution
        return { seconds: 0n, nanoseconds: 1_000_000 };
    }
};
