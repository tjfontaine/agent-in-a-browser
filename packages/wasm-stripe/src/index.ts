/**
 * @tjfontaine/wasm-stripe
 *
 * Stripe CLI module for the WASM shell.
 * Provides the 'stripe' command backed by a Go → wasip1 → wasip2 compiled binary.
 *
 * NOTE: This package exports only metadata. The loader is provided by
 * the consuming application (e.g., frontend/lazy-modules.ts) to avoid
 * Rollup trying to resolve the dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

/**
 * Module metadata for stripe-cli
 */
export const metadata: ModuleMetadata = {
    name: 'stripe-module',
    commands: [
        { name: 'stripe', mode: 'buffered' },
    ],
};

export default metadata;
