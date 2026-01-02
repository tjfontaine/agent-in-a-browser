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
        if (pollable.ready && pollable.ready()) {
            readyIndices.push(i);
        }
    }

    if (readyIndices.length > 0) {
        return new Uint32Array(readyIndices);
    }

    // If none ready, wait briefly then return timer index (assumed to be last pollable)
    // Use 1ms for responsive streaming - main loop timer provides the actual pacing
    await new Promise(resolve => setTimeout(resolve, 1));
    return new Uint32Array([list.length - 1]); // Return last pollable (timer) as ready
}
