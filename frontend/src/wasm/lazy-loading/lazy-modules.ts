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

// Import and re-export from wasm-loader for unified API
import {
    registerModule,
    isRegisteredCommand,
    isInteractiveCommand as isInteractiveCommandRegistry,
    getModuleForCommand as getModuleForCommandRegistry,
    getAllCommands,
    setTerminalContext,
    isTerminalContext,
    type CommandModule,
    type InputStream,
    type OutputStream,
    type ExecEnv,
    type CommandHandle,
} from '@tjfontaine/wasm-loader';

// Import metadata from wasm-* packages (no dynamic imports, safe for Rollup)
// Loaders are attached locally when registering to avoid build-time resolution
import { metadata as tsxMetadata } from '@tjfontaine/wasm-tsx';
import { metadata as sqliteMetadata } from '@tjfontaine/wasm-sqlite';
import { metadata as ratatuiMetadata } from '@tjfontaine/wasm-ratatui';
import { metadata as vimMetadata } from '@tjfontaine/wasm-vim';

// Static import for git-module (pure TS, not WASM - must be static for worker context)
import * as gitModule from '../git/git-module.js';

// Import types for internal use (these modules are still loaded by our loaders for now)
type TsxEngineModule = typeof import('../../../../packages/wasm-tsx/wasm/tsx-engine.js');
type SqliteModule = typeof import('../../../../packages/wasm-sqlite/wasm/sqlite-module.js');
type _RatatuiDemoModule = typeof import('../../../../packages/wasm-ratatui/wasm/ratatui-demo.js');

// Re-export types from wasm-loader for consumers
export type { CommandModule, CommandHandle, InputStream, OutputStream, ExecEnv };

// Cache for loaded modules
const loadedModules: Map<string, CommandModule> = new Map();

// Loading promises to prevent double-loading
const loadingPromises: Map<string, Promise<CommandModule>> = new Map();

// Re-export terminal context functions and utilities from wasm-loader
export { setTerminalContext, isTerminalContext, getAllCommands };

// ============================================================================
// Module Registration - Initialize at startup
// ============================================================================

let _modulesRegistered = false;

/**
 * Register all WASM modules.
 * Call this at startup before using any lazy-loaded commands.
 * 
 * Packages export only metadata (name, commands) - no loader functions.
 * Loaders are attached here to avoid Rollup resolving dynamic imports at build time.
 */
export function registerAllModules(): void {
    if (_modulesRegistered) return;

    console.log('[LazyLoader] Registering WASM modules...');

    // Combine package metadata with local loader functions
    registerModule({ ...tsxMetadata, loader: loadTsxEngine });
    registerModule({ ...sqliteMetadata, loader: loadSqliteModule });
    registerModule({ ...ratatuiMetadata, loader: loadRatatuiDemo });
    registerModule({ ...vimMetadata, loader: loadEdtuiModule });

    _modulesRegistered = true;
    console.log('[LazyLoader] All modules registered');
}

/**
 * Commands that are handled by lazy-loaded modules
 */
export const LAZY_COMMANDS: Record<string, string> = {
    'tsx': 'tsx-engine',
    'tsc': 'tsx-engine',
    'sqlite3': 'sqlite-module',
    'git': 'git-module',
    // Interactive TUI demos
    'ratatui-demo': 'ratatui-demo',
    'tui-demo': 'ratatui-demo',
    'counter': 'ratatui-demo',
    'ansi-demo': 'ratatui-demo',
    // Vim-style editor
    'vim': 'edtui-module',
    'vi': 'edtui-module',
    'edit': 'edtui-module',
    // Interactive shell (uses main runtime's shell:unix/command export)
    'sh': 'brush-shell',
    'shell': 'brush-shell',
    'bash': 'brush-shell',
};

/**
 * Commands that are interactive TUI apps (need direct terminal access).
 * These commands use spawn_interactive and bypass shell output buffering.
 * NOTE: Most of these are now derived from the registry. This set contains
 * any extra commands not yet in packages.
 */
export const INTERACTIVE_COMMANDS = new Set<string>([
    // Any non-packaged interactive commands go here
]);

/**
 * Check if a command is an interactive TUI (needs spawn_interactive).
 * Uses the registry if the command is registered, otherwise falls back to local check.
 */
export function isInteractiveCommand(commandName: string): boolean {
    // First check the registry (for packaged modules)
    if (isRegisteredCommand(commandName)) {
        return isInteractiveCommandRegistry(commandName);
    }
    // Fall back to legacy check
    return INTERACTIVE_COMMANDS.has(commandName);
}

/**
 * Check if a command should be lazy-loaded.
 * Uses the registry if registered, otherwise checks LAZY_COMMANDS.
 */
export function isLazyCommand(commandName: string): boolean {
    return isRegisteredCommand(commandName) || commandName in LAZY_COMMANDS;
}

/**
 * Get the module name for a lazy command.
 * Uses the registry if registered, otherwise checks LAZY_COMMANDS.
 */
export function getModuleForCommand(commandName: string): string | undefined {
    const registryModule = getModuleForCommandRegistry(commandName);
    if (registryModule) {
        return registryModule;
    }
    return LAZY_COMMANDS[commandName];
}


/**
 * Wrap a sync module (with run()) to provide spawn() interface
 */
function wrapSyncModule(syncModule: { run: TsxEngineModule['command']['run']; listCommands: TsxEngineModule['command']['listCommands'] }): CommandModule {
    return {
        spawn(name, args, env, stdin, stdout, stderr) {
            console.log(`[wrapSyncModule] spawn() called: name=${name}, args=`, args);
            console.log(`[wrapSyncModule] Calling syncModule.run()...`);
            // Execute synchronously and return immediately-resolved handle
            const exitCode = syncModule.run(name, args, env, stdin, stdout, stderr);
            console.log(`[wrapSyncModule] syncModule.run() returned exitCode=${exitCode}`);
            return {
                poll: () => {
                    console.log(`[wrapSyncModule] poll() called, returning ${exitCode}`);
                    return exitCode;
                },
                resolve: () => {
                    console.log(`[wrapSyncModule] resolve() called, resolving with ${exitCode}`);
                    return Promise.resolve(exitCode);
                },
            };
        },
        listCommands: () => syncModule.listCommands(),
    };
}

/**
 * Load the tsx-engine module
 */
async function loadTsxEngine(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading tsx-engine module...');
    const startTime = performance.now();

    // Dynamic import based on JSPI support
    // Safari needs sync variant to avoid WebAssembly.Suspending error
    let module: TsxEngineModule;
    if (hasJSPI) {
        module = await import('../../../../packages/wasm-tsx/wasm/tsx-engine.js');
    } else {
        module = await import('../../../../packages/wasm-tsx/wasm-sync/tsx-engine.js');
    }

    // With --tla-compat, we must await $init before accessing exports
    if ('$init' in module) {
        await (module as { $init: Promise<void> }).$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] tsx-engine loaded in ${loadTime.toFixed(0)}ms`);

    // Use JSPI wrapper when available since poll-impl.js makes run() async
    if (hasJSPI) {
        return wrapJspiModule(module.command as unknown as Parameters<typeof wrapJspiModule>[0]);
    }
    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load the sqlite-module
 */
async function loadSqliteModule(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading sqlite-module...');
    const startTime = performance.now();

    // Dynamic import based on JSPI support
    // Safari needs sync variant to avoid WebAssembly.Suspending error
    let module: SqliteModule;
    if (hasJSPI) {
        module = await import('../../../../packages/wasm-sqlite/wasm/sqlite-module.js');
    } else {
        module = await import('../../../../packages/wasm-sqlite/wasm-sync/sqlite-module.js');
    }

    // With --tla-compat, we must await $init before accessing exports
    if ('$init' in module) {
        await (module as { $init: Promise<void> }).$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] sqlite-module loaded in ${loadTime.toFixed(0)}ms`);

    // Use JSPI wrapper when available since poll-impl.js makes run() async
    if (hasJSPI) {
        return wrapJspiModule(module.command as unknown as Parameters<typeof wrapJspiModule>[0]);
    }
    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load the git-module (pure TypeScript, not WASM)
 * 
 * NOTE: git-module is statically imported because dynamic imports in worker
 * contexts fail in Playwright/Vite dev server. Since it's pure TypeScript
 * (not heavy WASM), the bundle size impact is minimal.
 */
async function loadGitModule(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading git-module (static import)...');
    // Use the statically imported module
    return gitModule.command as unknown as CommandModule;
}

/**
 * Wrap a JSPI-transpiled module (with async run()) to provide spawn() interface
 * 
 * Unlike wrapSyncModule, the run() function returns a Promise that resolves
 * when the command completes. JSPI allows the WASM stack to suspend on
 * blocking-read calls, returning control to JavaScript.
 */
function wrapJspiModule(jspiModule: {
    run: (name: string, args: string[], env: ExecEnv, stdin: InputStream, stdout: OutputStream, stderr: OutputStream) => Promise<number>;
    listCommands: TsxEngineModule['command']['listCommands']
}): CommandModule {
    return {
        spawn(name, args, env, stdin, stdout, stderr) {
            console.log(`[wrapJspiModule] spawn() called: name=${name}, args=`, args);

            // Start the async execution
            let exitCode: number | undefined = undefined;
            let resolvePromise: ((code: number) => void) | null = null;
            let rejectPromise: ((err: Error) => void) | null = null;

            // Create the execution promise
            const executionPromise = new Promise<number>((resolve, reject) => {
                resolvePromise = resolve;
                rejectPromise = reject;
            });

            // Start the JSPI run - this will suspend on blocking-read
            console.log(`[wrapJspiModule] Calling jspiModule.run() (async)...`);
            jspiModule.run(name, args, env, stdin, stdout, stderr)
                .then(code => {
                    console.log(`[wrapJspiModule] jspiModule.run() resolved with exitCode=${code}`);
                    exitCode = code;
                    resolvePromise?.(code);
                })
                .catch(err => {
                    console.error(`[wrapJspiModule] jspiModule.run() rejected:`, err);
                    exitCode = 1;
                    rejectPromise?.(err);
                });

            return {
                poll: () => exitCode,
                resolve: () => executionPromise,
            };
        },
        listCommands: () => jspiModule.listCommands(),
    };
}

/**
 * Load the ratatui-demo module (interactive TUI demo)
 * 
 * This module is transpiled with JSPI mode and async stdin imports/exports.
 * When the TUI calls stdin.blockingRead(), JSPI suspends the WASM stack
 * and returns control to JavaScript, allowing the event loop to deliver
 * keyboard input.
 */
async function loadRatatuiDemo(): Promise<CommandModule> {
    // Interactive TUI requires JSPI for stdin to work
    if (!hasJSPI) {
        throw new Error(
            'Interactive TUI apps require JSPI (JavaScript Promise Integration). ' +
            'Please use Chrome with JSPI enabled.'
        );
    }

    console.log('[LazyLoader] Loading ratatui-demo (JSPI mode)...');
    const startTime = performance.now();

    // Dynamic import of the JSPI-transpiled module
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const module = await import('../../../../packages/wasm-ratatui/wasm/ratatui-demo.js') as any;

    // Await $init for the JSPI module initialization
    if (module.$init) {
        await module.$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] ratatui-demo loaded in ${loadTime.toFixed(0)}ms`);

    // Use JSPI wrapper since run() returns a Promise with async exports
    // Note: jco generates types showing run() -> number, but with --async-exports
    // it actually returns Promise<number>. We cast through unknown.
    return wrapJspiModule(module.command as unknown as Parameters<typeof wrapJspiModule>[0]);
}

/**
 * Load the edtui-module (vim-style editor)
 * 
 * Supports both JSPI and sync modes for interactive editing.
 * In sync mode, uses the WorkerBridge stdin mechanism for keyboard input.
 */
async function loadEdtuiModule(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading edtui-module (vim editor)...');
    const startTime = performance.now();

    // Dynamic import based on JSPI support
    // Safari needs sync variant to avoid WebAssembly.Suspending error
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let module: any;
    if (hasJSPI) {
        module = await import('@tjfontaine/wasm-vim/wasm/edtui-module.js');
    } else {
        module = await import('@tjfontaine/wasm-vim/wasm-sync/edtui-module.js');
    }

    // Await $init for the module initialization
    if (module.$init) {
        await module.$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] edtui-module loaded in ${loadTime.toFixed(0)}ms`);

    // Use JSPI wrapper when available since poll-impl.js makes run() async
    if (hasJSPI) {
        return wrapJspiModule(module.command as unknown as Parameters<typeof wrapJspiModule>[0]);
    }
    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load the brush-shell from the main MCP server (interactive shell)
 * 
 * The main runtime now exports shell:unix/command alongside wasi:http/incoming-handler.
 * This gives the interactive shell access to all 50+ shell commands.
 * Supports both JSPI and sync modes for interactive shell access.
 */
async function loadBrushShell(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading interactive shell from MCP server...');
    const startTime = performance.now();

    // Dynamic import based on JSPI support
    // Safari needs sync variant to avoid WebAssembly.Suspending error
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let module: any;
    if (hasJSPI) {
        module = await import('@tjfontaine/mcp-wasm-server/mcp-server-jspi/ts-runtime-mcp.js');
    } else {
        module = await import('@tjfontaine/mcp-wasm-server/mcp-server-sync/ts-runtime-mcp.js');
    }

    // Await $init for the module initialization
    if (module.$init) {
        await module.$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] Interactive shell loaded in ${loadTime.toFixed(0)}ms`);

    // Use JSPI wrapper when available since poll-impl.js makes run() async
    if (hasJSPI) {
        return wrapJspiModule(module.command as unknown as Parameters<typeof wrapJspiModule>[0]);
    }
    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load a lazy module by name
 */
export async function loadLazyModule(moduleName: string): Promise<CommandModule> {
    // Check if already loaded
    const cached = loadedModules.get(moduleName);
    if (cached) {
        console.log(`[LazyLoader] ${moduleName} already loaded (cached)`);
        return cached;
    }

    // Check if currently loading
    const existingPromise = loadingPromises.get(moduleName);
    if (existingPromise) {
        console.log(`[LazyLoader] ${moduleName} already loading, waiting...`);
        return existingPromise;
    }

    // Start loading
    let loadPromise: Promise<CommandModule>;

    switch (moduleName) {
        case 'tsx-engine':
            loadPromise = loadTsxEngine();
            break;
        case 'sqlite-module':
            loadPromise = loadSqliteModule();
            break;
        case 'git-module':
            loadPromise = loadGitModule();
            break;
        case 'ratatui-demo':
            loadPromise = loadRatatuiDemo();
            break;
        case 'edtui-module':
            loadPromise = loadEdtuiModule();
            break;
        case 'brush-shell':
            loadPromise = loadBrushShell();
            break;
        default:
            throw new Error(`Unknown lazy module: ${moduleName}`);
    }

    loadingPromises.set(moduleName, loadPromise);

    try {
        const module = await loadPromise;
        loadedModules.set(moduleName, module);
        loadingPromises.delete(moduleName);
        return module;
    } catch (error) {
        loadingPromises.delete(moduleName);
        throw error;
    }
}

/**
 * Load the module for a specific command and return it
 */
export async function loadModuleForCommand(commandName: string): Promise<CommandModule | null> {
    const moduleName = LAZY_COMMANDS[commandName];
    if (!moduleName) {
        return null;
    }

    return loadLazyModule(moduleName);
}

/**
 * Get list of all lazy-loadable commands
 */
export function getLazyCommandList(): string[] {
    return Object.keys(LAZY_COMMANDS);
}

/**
 * Check if a module is already loaded
 */
export function isModuleLoaded(moduleName: string): boolean {
    return loadedModules.has(moduleName);
}

/**
 * Get a module synchronously (returns null if not loaded yet)
 */
export function getLoadedModuleSync(moduleName: string): CommandModule | null {
    return loadedModules.get(moduleName) ?? null;
}

/**
 * Trigger async preloading of a module (fire-and-forget)
 * This starts loading in the background so it's ready when needed.
 */
export function preloadModule(moduleName: string): void {
    if (loadedModules.has(moduleName) || loadingPromises.has(moduleName)) {
        return; // Already loaded or loading
    }

    console.log(`[LazyLoader] Preloading ${moduleName} in background...`);
    loadLazyModule(moduleName).catch(err => {
        console.error(`[LazyLoader] Failed to preload ${moduleName}:`, err);
    });
}

/**
 * Initialize all lazy modules eagerly.
 * Used in Sync mode (Safari/Firefox) where we can't do async suspension.
 * In JSPI mode (Chrome), this is not needed as modules load on-demand.
 */
export async function initializeForSyncMode(): Promise<void> {
    if (hasJSPI) {
        console.log('[LazyLoader] JSPI available, skipping eager load');
        return;
    }

    console.log('[LazyLoader] Sync mode - eager loading all lazy modules...');
    const startTime = performance.now();

    // Load all lazy modules in parallel
    // All interactive modules now support sync mode via WorkerBridge stdin mechanism
    const moduleNames = [
        'tsx-engine',
        'sqlite-module',
        'git-module',
        'edtui-module',   // Vim editor - now supports sync mode
        'brush-shell',    // Interactive shell - now supports sync mode
    ];
    await Promise.all(moduleNames.map(name =>
        loadLazyModule(name).catch(err => {
            console.error(`[LazyLoader] Failed to eager load ${name}:`, err);
        })
    ));

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] All modules loaded in ${loadTime.toFixed(0)}ms`);
}

// Re-export hasJSPI for consumers
export { hasJSPI };

// Auto-register modules at import time
// This ensures commands like vim are registered before any queries
registerAllModules();
