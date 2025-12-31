/**
 * @tjfontaine/wasm-modules
 * 
 * Aggregator package that re-exports all WASM module metadata.
 * 
 * Usage:
 * - Import `allMetadata` to get an array of all module metadata
 * - Import individual metadata exports for specific modules  
 * - Re-exports all types from @tjfontaine/wasm-loader
 * 
 * NOTE: This package exports only metadata (name, commands), not loaders.
 * Loaders are provided by the consuming application to avoid Rollup
 * resolving dynamic WASM imports at build time.
 */

import type { ModuleMetadata } from '@tjfontaine/wasm-loader';

// Import all module metadata
import { metadata as tsxMetadata } from '@tjfontaine/wasm-tsx';
import { metadata as sqliteMetadata } from '@tjfontaine/wasm-sqlite';
import { metadata as ratatuiMetadata } from '@tjfontaine/wasm-ratatui';
import { metadata as vimMetadata } from '@tjfontaine/wasm-vim';

/**
 * All module metadata
 */
export const allMetadata: ModuleMetadata[] = [
    tsxMetadata,
    sqliteMetadata,
    ratatuiMetadata,
    vimMetadata,
];

/**
 * Get all command names across all modules
 */
export function getAllCommandNames(): string[] {
    return allMetadata.flatMap(m => m.commands.map(c => c.name));
}

/**
 * Get metadata for a specific module by name
 */
export function getModuleMetadata(moduleName: string): ModuleMetadata | undefined {
    return allMetadata.find(m => m.name === moduleName);
}

// Re-export individual metadata
export { tsxMetadata, sqliteMetadata, ratatuiMetadata, vimMetadata };

// Re-export types and utilities from wasm-loader
export {
    // Registry functions
    registerModule,
    getCommandRegistration,
    getCommandConfig,
    isRegisteredCommand,
    isInteractiveCommand,
    isBufferedCommand,
    getModuleForCommand,
    getAllCommands,
    getAllModules,
    loadModuleForCommand,

    // Terminal context
    setTerminalContext,
    isTerminalContext,

    // Types
    type ModuleMetadata,
    type ModuleRegistration,
    type CommandConfig,
    type CommandMode,
    type CommandModule,
    type CommandHandle,
    type ExecEnv,
    type InputStream,
    type OutputStream,
    type Pollable,
} from '@tjfontaine/wasm-loader';
