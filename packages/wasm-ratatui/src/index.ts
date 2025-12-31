/**
 * @tjfontaine/wasm-ratatui
 * 
 * Ratatui TUI demo module for the WASM shell.
 * Provides 'ratatui-demo', 'tui-demo', 'counter', 'ansi-demo' commands.
 * 
 * NOTE: This package exports only metadata. The loader is provided by
 * the consuming application (e.g., frontend/lazy-modules.ts) to avoid
 * Rollup trying to resolve the dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

/**
 * Module metadata for ratatui demos
 */
export const metadata: ModuleMetadata = {
    name: 'ratatui-demo',
    commands: [
        { name: 'ratatui-demo', mode: 'tui' },
        { name: 'tui-demo', mode: 'tui' },
        { name: 'counter', mode: 'tui' },
        { name: 'ansi-demo', mode: 'tui' },
    ],
};

export default metadata;
