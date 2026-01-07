/**
 * Lazy Module Loader
 *
 * Dynamically loads heavy WASM modules (tsx-engine, sqlite-module) on demand.
 * This reduces initial load time by deferring these modules until first use.
 *
 * Supports dual async modes:
 * - JSPI mode (Chrome): True lazy loading with async suspension
 * - Sync mode (Safari/Firefox): Eager loading at startup
 */
import { hasJSPI } from './async-mode.js';
import { getAllCommands, setTerminalContext, isTerminalContext, type CommandModule, type InputStream, type OutputStream, type ExecEnv, type CommandHandle } from '@tjfontaine/wasm-loader';
export type { CommandModule, CommandHandle, InputStream, OutputStream, ExecEnv };
export { setTerminalContext, isTerminalContext, getAllCommands };
/**
 * Register all WASM modules.
 * Call this at startup before using any lazy-loaded commands.
 *
 * Packages export only metadata (name, commands) - no loader functions.
 * Loaders are attached here to avoid Rollup resolving dynamic imports at build time.
 */
export declare function registerAllModules(): void;
/**
 * Commands that are handled by lazy-loaded modules
 */
export declare const LAZY_COMMANDS: Record<string, string>;
/**
 * Commands that are interactive TUI apps (need direct terminal access).
 * These commands use spawn_interactive and bypass shell output buffering.
 * NOTE: Most of these are now derived from the registry. This set contains
 * any extra commands not yet in packages.
 */
export declare const INTERACTIVE_COMMANDS: Set<string>;
/**
 * Check if a command is an interactive TUI (needs spawn_interactive).
 * Uses the registry if the command is registered, otherwise falls back to local check.
 */
export declare function isInteractiveCommand(commandName: string): boolean;
/**
 * Check if a command should be lazy-loaded.
 * Uses the registry if registered, otherwise checks LAZY_COMMANDS.
 */
export declare function isLazyCommand(commandName: string): boolean;
/**
 * Get the module name for a lazy command.
 * Uses the registry if registered, otherwise checks LAZY_COMMANDS.
 */
export declare function getModuleForCommand(commandName: string): string | undefined;
/**
 * Load a lazy module by name
 */
export declare function loadLazyModule(moduleName: string): Promise<CommandModule>;
/**
 * Load the module for a specific command and return it
 */
export declare function loadModuleForCommand(commandName: string): Promise<CommandModule | null>;
/**
 * Get list of all lazy-loadable commands
 */
export declare function getLazyCommandList(): string[];
/**
 * Check if a module is already loaded
 */
export declare function isModuleLoaded(moduleName: string): boolean;
/**
 * Get a module synchronously (returns null if not loaded yet)
 */
export declare function getLoadedModuleSync(moduleName: string): CommandModule | null;
/**
 * Trigger async preloading of a module (fire-and-forget)
 * This starts loading in the background so it's ready when needed.
 */
export declare function preloadModule(moduleName: string): void;
/**
 * Initialize all lazy modules eagerly.
 * Used in Sync mode (Safari/Firefox) where we can't do async suspension.
 * In JSPI mode (Chrome), this is not needed as modules load on-demand.
 */
export declare function initializeForSyncMode(): Promise<void>;
export { hasJSPI };
//# sourceMappingURL=lazy-modules.d.ts.map