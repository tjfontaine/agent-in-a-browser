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
    console.log(`[poll-impl] poll() called with ${list.length} pollables`);

    // Check if any pollable is already ready
    const readyIndices = [];
    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        const hasReady = pollable.ready && typeof pollable.ready === 'function';
        const isReady = hasReady && pollable.ready();
        console.log(`[poll-impl] pollable[${i}]: hasReady=${hasReady}, isReady=${isReady}, hasBlock=${pollable.block && typeof pollable.block === 'function'}`);
        if (isReady) {
            readyIndices.push(i);
        }
    }

    if (readyIndices.length > 0) {
        console.log(`[poll-impl] ${readyIndices.length} already ready:`, readyIndices);
        return new Uint32Array(readyIndices);
    }

    // None ready - race all pollables with block() methods
    // Also include a fallback timeout in case no pollables have block()
    const blockPromises = [];

    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        if (pollable.block && typeof pollable.block === 'function') {
            // Wrap each block() call to return its index when resolved
            console.log(`[poll-impl] Adding block() promise for pollable[${i}]`);
            blockPromises.push(
                Promise.resolve(pollable.block()).then(() => {
                    console.log(`[poll-impl] pollable[${i}].block() resolved`);
                    return i;
                })
            );
        }
    }

    if (blockPromises.length === 0) {
        // No pollables have block() - wait briefly and return last index (timer fallback)
        console.log('[poll-impl] No block() methods, using timer fallback');
        await new Promise(resolve => setTimeout(resolve, 1));
        return new Uint32Array([list.length - 1]);
    }

    console.log(`[poll-impl] Racing ${blockPromises.length} block() promises...`);
    // Race all block() promises - first to resolve wins
    const readyIndex = await Promise.race(blockPromises);
    console.log(`[poll-impl] Race resolved with index: ${readyIndex}`);

    // After one resolves, check all for readiness (multiple might be ready now)
    const allReady = [];
    for (let i = 0; i < list.length; i++) {
        const pollable = list[i];
        if (pollable.ready && pollable.ready()) {
            allReady.push(i);
        }
    }

    console.log(`[poll-impl] Returning ready indices:`, allReady.length > 0 ? allReady : [readyIndex]);
    return new Uint32Array(allReady.length > 0 ? allReady : [readyIndex]);
}
