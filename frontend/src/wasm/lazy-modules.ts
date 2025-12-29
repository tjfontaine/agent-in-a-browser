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

// Import types from generated modules
type TsxEngineModule = typeof import('./tsx-engine/tsx-engine.js');
type SqliteModule = typeof import('./sqlite-module/sqlite-module.js');

// Re-export stream types from the generated WASM module for consumers
// These are the actual WASI interfaces that the WASM modules use
export type InputStream = import('./tsx-engine/interfaces/wasi-io-streams.js').InputStream;
export type OutputStream = import('./tsx-engine/interfaces/wasi-io-streams.js').OutputStream;
export type ExecEnv = import('./tsx-engine/interfaces/shell-unix-command.js').ExecEnv;

// Handle for a spawned command - supports poll and resolve patterns
export interface CommandHandle {
    // Poll for completion, returns exit code when done, undefined if still running
    poll(): number | undefined;
    // Wait for completion, returns exit code
    resolve(): Promise<number>;
}

// Interface that lazy-loaded command modules export
export interface CommandModule {
    // Spawn a command, returns handle for polling/resolving
    spawn: (
        name: string,
        args: string[],
        env: ExecEnv,
        stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ) => CommandHandle;
    listCommands: () => string[];
}

// Cache for loaded modules
const loadedModules: Map<string, CommandModule> = new Map();

// Loading promises to prevent double-loading
const loadingPromises: Map<string, Promise<CommandModule>> = new Map();

/**
 * Commands that are handled by lazy-loaded modules
 */
export const LAZY_COMMANDS: Record<string, string> = {
    'tsx': 'tsx-engine',
    'tsc': 'tsx-engine',
    'sqlite3': 'sqlite-module',
    'git': 'git-module',
};

/**
 * Check if a command should be lazy-loaded
 */
export function isLazyCommand(commandName: string): boolean {
    return commandName in LAZY_COMMANDS;
}

/**
 * Get the module name for a lazy command
 */
export function getModuleForCommand(commandName: string): string | undefined {
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

    // Dynamic import of the transpiled module (typed)
    const module: TsxEngineModule = await import('./tsx-engine/tsx-engine.js');

    // With --tla-compat, we must await $init before accessing exports
    if (module.$init) {
        await module.$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] tsx-engine loaded in ${loadTime.toFixed(0)}ms`);

    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load the sqlite-module
 */
async function loadSqliteModule(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading sqlite-module...');
    const startTime = performance.now();

    // Dynamic import of the transpiled module (typed)
    const module: SqliteModule = await import('./sqlite-module/sqlite-module.js');

    // With --tla-compat, we must await $init before accessing exports
    if (module.$init) {
        await module.$init;
    }

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] sqlite-module loaded in ${loadTime.toFixed(0)}ms`);

    // Wrap the sync command interface to provide spawn()
    return wrapSyncModule(module.command);
}

/**
 * Load the git-module (pure TypeScript, not WASM)
 */
async function loadGitModule(): Promise<CommandModule> {
    console.log('[LazyLoader] Loading git-module...');
    const startTime = performance.now();

    const module = await import('./git-module.js');

    const loadTime = performance.now() - startTime;
    console.log(`[LazyLoader] git-module loaded in ${loadTime.toFixed(0)}ms`);

    return module.command as unknown as CommandModule;
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
    const moduleNames = ['tsx-engine', 'sqlite-module'];
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
