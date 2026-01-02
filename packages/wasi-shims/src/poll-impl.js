/* global console */
/**
 * poll-impl.js - Custom poll implementation for browser environment
 * 
 * The browser version of @bytecodealliance/preview2-shim has stub poll functions.
 * This provides a working poll() implementation while re-exporting the Pollable
 * class from preview2-shim to maintain resource compatibility.
 */

// Import poll module to re-export the Pollable class
// This ensures resource validation works since clocks-impl.js creates DurationPollable
// that extends from this same BasePollable
import { poll as pollModule } from '@bytecodealliance/preview2-shim/io';

// Re-export the Pollable class from preview2-shim
export const Pollable = pollModule.Pollable;

// Export poll function directly (JCO generates: await poll(list))
export async function poll(list) {
    // Check if any pollable is already ready
    const readyIndices = [];
    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        if (pollable.ready && typeof pollable.ready === 'function' && pollable.ready()) {
            readyIndices.push(i);
        }
    }

    if (readyIndices.length > 0) {
        return new Uint32Array(readyIndices);
    }

    // None ready - race all pollables with block() methods
    const blockPromises = [];

    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        if (pollable.block && typeof pollable.block === 'function') {
            blockPromises.push(
                Promise.resolve(pollable.block()).then(() => i)
            );
        }
    }

    if (blockPromises.length === 0) {
        // No pollables have block() - wait briefly and return last index (timer fallback)
        await new Promise(resolve => setTimeout(resolve, 1));
        return new Uint32Array([list.length - 1]);
    }

    // Race all block() promises - first to resolve wins
    const readyIndex = await Promise.race(blockPromises);

    // After one resolves, check all for readiness (multiple might be ready now)
    const allReady = [];
    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        if (pollable.ready && pollable.ready()) {
            allReady.push(i);
        }
    }

    return new Uint32Array(allReady.length > 0 ? allReady : [readyIndex]);
}
