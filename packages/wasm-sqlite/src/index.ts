/**
 * @tjfontaine/wasm-sqlite
 * 
 * SQLite module for the WASM shell.
 * Provides 'sqlite3' command.
 * 
 * NOTE: This package exports only metadata. The loader is provided by
 * the consuming application (e.g., frontend/lazy-modules.ts) to avoid
 * Rollup trying to resolve the dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

/**
 * Module metadata for sqlite
 */
export const metadata: ModuleMetadata = {
    name: 'sqlite-module',
    commands: [
        { name: 'sqlite3', mode: 'buffered' },
    ],
};

export default metadata;
