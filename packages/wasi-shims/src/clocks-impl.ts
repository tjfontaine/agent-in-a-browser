/**
 * Custom WASI clocks implementation for browser environments.
 * 
 * Provides proper implementations of monotonic-clock and wall-clock.
 * 
 * IMPORTANT: Imports DurationPollable and InstantPollable from poll-impl.ts
 * where all Pollable subclasses are defined. This ensures instanceof checks pass.
 */

// Import the pollable classes from poll-impl.ts (all classes defined in same file)
import { DurationPollable, InstantPollable } from './poll-impl.js';

export const monotonicClock = {
    resolution(): bigint {
        // Browser performance.now() typically has ~1ms resolution
        // Return in nanoseconds
        return 1_000_000n;
    },

    now(): bigint {
        // performance.now() is in milliseconds, convert to nanoseconds
        return BigInt(Math.floor(performance.now() * 1e6));
    },

    subscribeInstant(instant: bigint): InstantPollable {
        console.log(`[monotonic-clock] subscribeInstant: ${instant}`);
        return new InstantPollable(instant);
    },

    subscribeDuration(duration: bigint): DurationPollable {
        const durationNanos = BigInt(duration);
        return new DurationPollable(durationNanos);
    }
};

export const wallClock = {
    now(): { seconds: bigint; nanoseconds: number } {
        const now = Date.now(); // in milliseconds since epoch
        const seconds = BigInt(Math.floor(now / 1000));
        const nanoseconds = (now % 1000) * 1_000_000;
        return { seconds, nanoseconds };
    },

    resolution(): { seconds: bigint; nanoseconds: number } {
        // ~1ms resolution
        return { seconds: 0n, nanoseconds: 1_000_000 };
    }
};
