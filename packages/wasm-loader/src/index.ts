/**
 * WASM Module Loader - Core Types and Registry
 * 
 * Provides the module registration system for lazy-loaded WASM commands.
 * Each WASM module package exports a registration object that describes
 * the commands it provides and their capabilities.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Command execution mode:
 * - 'buffered': Only works with piped I/O (git, tsx, sqlite3)
 * - 'tui': Only works with terminal/raw mode (vim, ratatui-demo)
 * - 'both': Works in either mode (future commands)
 */
export type CommandMode = 'buffered' | 'tui' | 'both';

/**
 * Command configuration within a module
 */
export interface CommandConfig {
    /** Command name (e.g., 'vim', 'git') */
    name: string;
    /** Execution mode capability */
    mode: CommandMode;
}

/**
 * WASI streams interface - matches generated wasi:io/streams@0.2.6
 * These interfaces must match the generated WASM module types exactly.
 */

/**
 * Pollable resource (opaque handle for async waiting)
 */
export interface Pollable {
    ready(): boolean;
    block(): void;
}

/**
 * Input stream for reading data
 */
export interface InputStream {
    /** Non-blocking read - may return fewer bytes than requested */
    read(len: bigint): Uint8Array;
    /** Blocking read - waits until data available */
    blockingRead(len: bigint): Uint8Array;
    /** Subscribe for readiness */
    subscribe(): Pollable;
}

/**
 * Output stream for writing data
 */
export interface OutputStream {
    /** Check how many bytes can be written without blocking */
    checkWrite(): bigint;
    /** Write data (may require flush) */
    write(contents: Uint8Array): void;
    /** Write and flush synchronously */
    blockingWriteAndFlush(contents: Uint8Array): void;
    /** Flush pending data synchronously */
    blockingFlush(): void;
    /** Subscribe for write readiness */
    subscribe(): Pollable;
}

/**
 * Execution environment
 */
export interface ExecEnv {
    cwd: string;
    vars: [string, string][];
}

/**
 * Handle for a spawned command
 */
export interface CommandHandle {
    poll(): number | undefined;
    resolve(): Promise<number>;
}

/**
 * Interface that command modules must implement
 */
export interface CommandModule {
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

/**
 * Module metadata - exported by WASM packages without a loader.
 * This allows packages to be imported without triggering dynamic WASM imports.
 * The loader is attached by the consuming application (e.g., lazy-modules.ts).
 */
export interface ModuleMetadata {
    /** Unique module name (e.g., 'tsx-engine') */
    name: string;
    /** Commands provided by this module */
    commands: CommandConfig[];
}

/**
 * Module registration object - includes metadata plus a loader.
 * Created by the consuming application when registering modules.
 */
export interface ModuleRegistration extends ModuleMetadata {
    /** Async loader function - returns the command module */
    loader: () => Promise<CommandModule>;
}

// ============================================================================
// Registry
// ============================================================================

/** Registered modules by module name */
const moduleRegistry = new Map<string, ModuleRegistration>();

/** Command to module mapping */
const commandRegistry = new Map<string, ModuleRegistration>();

/**
 * Register a WASM module with the loader
 */
export function registerModule(registration: ModuleRegistration): void {
    moduleRegistry.set(registration.name, registration);

    for (const cmd of registration.commands) {
        commandRegistry.set(cmd.name, registration);
    }

    console.log(`[WasmLoader] Registered module '${registration.name}' with commands: ${registration.commands.map(c => c.name).join(', ')}`);
}

/**
 * Get registration for a command
 */
export function getCommandRegistration(command: string): ModuleRegistration | undefined {
    return commandRegistry.get(command);
}

/**
 * Get command configuration
 */
export function getCommandConfig(command: string): CommandConfig | undefined {
    const reg = commandRegistry.get(command);
    if (!reg) return undefined;
    return reg.commands.find(c => c.name === command);
}

/**
 * Check if a command is registered
 */
export function isRegisteredCommand(command: string): boolean {
    return commandRegistry.has(command);
}

/**
 * Check if a command supports TUI mode
 */
export function isInteractiveCommand(command: string): boolean {
    const config = getCommandConfig(command);
    if (!config) return false;
    return config.mode === 'tui' || config.mode === 'both';
}

/**
 * Check if a command supports buffered mode
 */
export function isBufferedCommand(command: string): boolean {
    const config = getCommandConfig(command);
    if (!config) return false;
    return config.mode === 'buffered' || config.mode === 'both';
}

/**
 * Get module name for a command
 */
export function getModuleForCommand(command: string): string | undefined {
    return commandRegistry.get(command)?.name;
}

/**
 * Get all registered commands
 */
export function getAllCommands(): string[] {
    return Array.from(commandRegistry.keys());
}

/**
 * Get all registered modules
 */
export function getAllModules(): ModuleRegistration[] {
    return Array.from(moduleRegistry.values());
}

/**
 * Load a module by command name
 */
export async function loadModuleForCommand(command: string): Promise<CommandModule | undefined> {
    const reg = commandRegistry.get(command);
    if (!reg) return undefined;
    return reg.loader();
}

// ============================================================================
// Terminal Context (for isatty detection)
// ============================================================================

let _terminalContext = false;

/**
 * Set the terminal context for the current command execution
 */
export function setTerminalContext(isTty: boolean): void {
    _terminalContext = isTty;
}

/**
 * Check if current execution is in a terminal context
 */
export function isTerminalContext(): boolean {
    return _terminalContext;
}
