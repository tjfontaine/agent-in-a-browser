/**
 * @tjfontaine/wasm-vim
 * 
 * Vim-style editor module (edtui-module) for the WASM shell.
 * Provides 'vim', 'vi', and 'edit' commands.
 * 
 * NOTE: This package exports only metadata. The loader is provided by
 * the consuming application (e.g., frontend/lazy-modules.ts) to avoid
 * Rollup trying to resolve the dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

/**
 * Module metadata for the vim editor
 */
export const metadata: ModuleMetadata = {
    name: 'edtui-module',
    commands: [
        { name: 'vim', mode: 'tui' },
        { name: 'vi', mode: 'tui' },
        { name: 'edit', mode: 'tui' },
    ],
};

export default metadata;
