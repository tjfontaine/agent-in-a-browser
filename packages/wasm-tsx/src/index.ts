/**
 * @tjfontaine/wasm-tsx
 * 
 * TSX/TypeScript engine module for the WASM shell.
 * Provides 'tsx' and 'tsc' commands.
 * 
 * NOTE: This package exports only metadata. The loader is provided by
 * the consuming application (e.g., frontend/lazy-modules.ts) to avoid
 * Rollup trying to resolve the dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

/**
 * Module metadata for tsx engine
 */
export const metadata: ModuleMetadata = {
    name: 'tsx-engine',
    commands: [
        { name: 'tsx', mode: 'buffered' },
        { name: 'tsc', mode: 'buffered' },
    ],
};

export default metadata;
