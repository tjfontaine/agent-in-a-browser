/**
 * Extended util polyfill for browser
 * Adds isDeepStrictEqual which is required by @inkjs/ui
 */

// Re-export everything from the base util polyfill
export * from 'util';

// Add isDeepStrictEqual using fast-deep-equal (which is already a dep)
import deepEqual from 'fast-deep-equal';

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
    return deepEqual(a, b);
}
