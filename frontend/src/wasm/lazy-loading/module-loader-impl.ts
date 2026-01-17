/**
 * Module Loader Implementation
 * 
 * Provides the mcp:module-loader/loader interface that the core WASM runtime
 * imports. With JSPI (JavaScript Promise Integration), these functions can be
 * async and the WASM runtime will suspend/resume automatically.
 * 
 * Modules load ON-DEMAND when first command runs (true lazy loading).
 */

import {
    LAZY_COMMANDS,
    loadLazyModule,
    getLoadedModuleSync,
    getModuleForCommand,
    hasJSPI,
    isInteractiveCommand as isInteractiveCommandImpl,
    setTerminalContext,
    type CommandModule,
    type ExecEnv as LazyExecEnv,
} from './lazy-modules.js';
import { CustomInputStream, CustomOutputStream } from '@tjfontaine/wasi-shims/streams.js';
import { poll } from '@bytecodealliance/preview2-shim/io';

// Import ghostty terminal streams for interactive TUI applications
import {
    stdin as ghosttyStdin,
    stdout as ghosttyStdout,
    stderr as ghosttyStderr,
    setPipedStreams,
    clearPipedStreams
} from '@tjfontaine/wasi-shims/ghostty-cli-shim.js';

// Get the Pollable base class from preview2-shim
// @ts-expect-error - Pollable is exported at runtime
const { Pollable: BasePollable } = poll as { Pollable: new () => { ready(): boolean; block(): void } };

// Types from the generated WIT bindings
export interface ExecEnv {
    cwd: string;
    vars: [string, string][];
}

export interface TerminalSize {
    cols: number;
    rows: number;
}

/**
 * Check if a command should be handled by a lazy module.
 * 
 * IMPORTANT: This function MUST be synchronous because it's called from sync-mode
 * WASM bindings (Safari/Firefox). The WASM bindings don't await the return value,
 * so returning a Promise would cause a type error in utf8Encode.
 * 
 * Returns the module name if the command is lazy-loadable.
 */
export function getLazyModule(command: string): string | undefined {
    const moduleName = LAZY_COMMANDS[command];
    if (moduleName) {
        console.log(`[ModuleLoader] Command '${command}' -> module '${moduleName}'`);

        // Start loading the module in background (will be ready when spawnLazyCommand is called)
        loadLazyModule(moduleName).catch(e => {
            console.warn(`[ModuleLoader] Background preload of ${moduleName} failed:`, e);
        });

        return moduleName;
    }
    return undefined;
}

/**
 * Spawn a lazy command process.
 * 
 * DUAL-MODE FUNCTION:
 * - In JSPI mode (Chrome): Can load modules async, returns Promise<LazyProcess>
 * - In sync mode (Safari/Firefox): Must return synchronously from cache
 * 
 * The WASM bindings handle both cases appropriately - JSPI bindings can await,
 * sync bindings expect immediate return.
 */
export function spawnLazyCommand(
    moduleName: string,
    command: string,
    args: string[],
    env: ExecEnv,
): LazyProcess | Promise<LazyProcess> {
    console.log(`[ModuleLoader] spawnLazyCommand: ${command} (module: ${moduleName}, hasJSPI: ${hasJSPI})`);

    // Set terminal context to false (piped/buffered mode)
    setTerminalContext(false);

    // First, check if module is already cached (works for both modes)
    const cachedModule = getLoadedModuleSync(moduleName);
    if (cachedModule) {
        console.log(`[ModuleLoader] Module '${moduleName}' retrieved from cache for command '${command}'`);
        return new LazyProcess(moduleName, command, args, env, cachedModule);
    }

    // Module not cached - behavior differs by mode
    if (hasJSPI) {
        // JSPI mode: Load the module async and return Promise
        console.log(`[ModuleLoader] JSPI mode: loading module '${moduleName}' async`);
        return loadLazyModule(moduleName).then(module => {
            console.log(`[ModuleLoader] Module '${moduleName}' loaded async for command '${command}'`);
            return new LazyProcess(moduleName, command, args, env, module);
        });
    } else {
        // Sync mode: Module should have been pre-loaded via initializeForSyncMode()
        throw new Error(
            `Module '${moduleName}' not loaded. In sync mode (Safari/Firefox), ` +
            `ensure initializeForSyncMode() was called during startup.`
        );
    }
}

/**
 * Spawn an interactive command process (for TUI applications).
 * Automatically sets raw mode and configures terminal size.
 * 
 * DUAL-MODE: Like spawnLazyCommand, returns sync or Promise based on hasJSPI.
 */
export function spawnInteractive(
    moduleName: string,
    command: string,
    args: string[],
    env: ExecEnv,
    size: TerminalSize,
): LazyProcess | Promise<LazyProcess> {
    console.log(`[ModuleLoader] spawnInteractive: ${command} (module: ${moduleName}, size: ${size.cols}x${size.rows}, hasJSPI: ${hasJSPI})`);

    // Set terminal context to true (TTY mode)
    setTerminalContext(true);

    // Helper to create and start the process
    const createProcess = (module: CommandModule): LazyProcess => {
        const process = new LazyProcess(moduleName, command, args, env, module, size);
        process.setRawMode(true); // Interactive mode starts in raw mode
        process.execute(); // Start execution immediately for interactive apps
        return process;
    };

    // Try cache first (works for both modes)
    const cachedModule = getLoadedModuleSync(moduleName);
    if (cachedModule) {
        console.log(`[ModuleLoader] Module '${moduleName}' retrieved from cache for interactive command '${command}'`);
        return createProcess(cachedModule);
    }

    // Module not cached - behavior differs by mode
    if (hasJSPI) {
        // JSPI mode: Load the module async and return Promise
        console.log(`[ModuleLoader] JSPI mode: loading module '${moduleName}' async for interactive`);
        return loadLazyModule(moduleName).then(module => {
            console.log(`[ModuleLoader] Module '${moduleName}' loaded async for interactive command '${command}'`);
            return createProcess(module);
        });
    } else {
        // Sync mode: Module should have been pre-loaded
        throw new Error(
            `Module '${moduleName}' not loaded. In sync mode (Safari/Firefox), ` +
            `ensure initializeForSyncMode() was called during startup.`
        );
    }
}

/**
 * Check if a command is an interactive TUI (needs spawn_interactive).
 * This queries the module registry to determine dispatch mode.
 */
export function isInteractiveCommand(command: string): boolean {
    const result = isInteractiveCommandImpl(command);
    console.log(`[ModuleLoader] isInteractiveCommand('${command}') => ${result}`);
    return result;
}

/**
 * Check if JSPI (JavaScript Promise Integration) is available.
 * When true, spawn-lazy-command should be preferred over spawn-worker-command
 * to avoid module duplication issues in isolated Worker contexts.
 */
export function hasJspi(): boolean {
    return hasJSPI;
}

/**
 * ReadyPollable - A pollable that is immediately ready since module is already loaded.
 */
class ReadyPollable extends BasePollable {
    private _module: CommandModule;

    constructor(module: CommandModule) {
        super();
        this._module = module;
    }

    ready(): boolean {
        return true; // Module is already loaded
    }

    block(): void {
        // Nothing to block on - module is already loaded
    }

    getModule(): CommandModule {
        return this._module;
    }
}

/**
 * LazyProcess - Handle for a running lazy command with streaming I/O.
 * The module is passed in already loaded (since spawnLazyCommand awaited it).
 */
export class LazyProcess {
    private stdinBuffer: Uint8Array[] = [];
    private stdinClosed = false;
    private stdoutBuffer: Uint8Array[] = [];
    private stderrBuffer: Uint8Array[] = [];
    private exitCode: number | undefined = undefined;
    private started = false;
    private executionPromise: Promise<void> | null = null;

    private moduleName: string;
    private command: string;
    private args: string[];
    private env: ExecEnv;
    private module: CommandModule;

    private readyPollable: ReadyPollable;

    // Terminal state
    private terminalSize: TerminalSize;
    private rawMode: boolean = false;

    constructor(
        moduleName: string,
        command: string,
        args: string[],
        env: ExecEnv,
        module: CommandModule,
        terminalSize?: TerminalSize,
    ) {
        this.moduleName = moduleName;
        this.command = command;
        this.args = args;
        this.env = env;
        this.module = module;
        this.terminalSize = terminalSize ?? { cols: 80, rows: 24 };

        // Module is already loaded
        this.readyPollable = new ReadyPollable(module);
    }

    getReadyPollable(): ReadyPollable {
        return this.readyPollable;
    }

    isReady(): boolean {
        return true; // Always ready since module was loaded in spawnLazyCommand
    }

    writeStdin(data: Uint8Array): bigint {
        if (this.stdinClosed) {
            return BigInt(0);
        }
        this.stdinBuffer.push(new Uint8Array(data));
        return BigInt(data.length);
    }

    closeStdin(): void {
        console.log(`[LazyProcess] closeStdin() called, started=${this.started}`);
        this.stdinClosed = true;
        if (!this.started) {
            this.started = true;
            // Start execution - store promise for tryWait to await
            this.executionPromise = this.executeAsync();
        }
        console.log(`[LazyProcess] closeStdin() complete, stdoutBuffer.length=${this.stdoutBuffer.length}, stderrBuffer.length=${this.stderrBuffer.length}`);
    }

    /**
     * Execute the process immediately (for interactive mode).
     * Unlike closeStdin(), this starts execution right away with live stdin access.
     */
    execute(): void {
        if (this.started) {
            console.warn('[LazyProcess] execute() called but process already started');
            return;
        }
        console.log(`[LazyProcess] execute() called for interactive mode`);
        this.started = true;
        // Start execution with live stdin - use executeInteractive instead
        this.executionPromise = this.executeInteractive();
    }

    /**
     * Execute in interactive mode - stdin reads from ghostty terminal.
     * 
     * TUI apps (like vim, ratatui-demo) need to read from the actual terminal
     * and write output directly to the terminal. We use ghostty-cli-shim streams
     * instead of internal buffers.
     */
    private async executeInteractive(): Promise<void> {
        console.log(`[LazyProcess] === INTERACTIVE EXECUTE START === command: ${this.command}`);
        console.log(`[LazyProcess] Using ghostty terminal streams for stdin/stdout`);

        // Use ghostty terminal streams for TUI apps
        // These streams are connected to the actual ghostty-web terminal
        const stdinStream = ghosttyStdin.getStdin();
        const stdoutStream = ghosttyStdout.getStdout();
        const stderrStream = ghosttyStderr.getStderr();

        try {
            const execEnv: LazyExecEnv = {
                cwd: this.env.cwd,
                vars: this.env.vars,
            };

            console.log(`[LazyProcess] Interactive: Calling module.spawn(${this.command})`);

            const handle = this.module.spawn(
                this.command,
                this.args,
                execEnv,
                stdinStream as never,
                stdoutStream as never,
                stderrStream as never,
            );

            this.exitCode = await handle.resolve();
            console.log(`[LazyProcess] === INTERACTIVE EXECUTE END === exit: ${this.exitCode}`);
        } catch (error) {
            console.error(`[LazyProcess] Interactive EXCEPTION:`, error);
            this.stderrBuffer.push(new TextEncoder().encode(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`
            ));
            this.exitCode = 1;
        }
    }

    readStdout(maxBytes: bigint): Uint8Array {
        const result = this.readFromBuffer(this.stdoutBuffer, Number(maxBytes));
        // Only log when there's actual data to reduce noise
        if (result.length > 0) {
            const text = new TextDecoder().decode(result);
            console.log(`[LazyProcess] readStdout => ${result.length} bytes:`, JSON.stringify(text));
        }
        return result;
    }

    readStderr(maxBytes: bigint): Uint8Array {
        const result = this.readFromBuffer(this.stderrBuffer, Number(maxBytes));
        if (result.length > 0) {
            const text = new TextDecoder().decode(result);
            console.log(`[LazyProcess] readStderr(${maxBytes}) => ${result.length} bytes:`, JSON.stringify(text));
        }
        return result;
    }

    async tryWait(): Promise<number | undefined> {
        // For batch mode (non-interactive), we need to wait for execution to complete.
        // This allows the JavaScript event loop to process pending Promises (like OPFS operations)
        // while JSPI suspends the WASM stack.
        if (this.executionPromise && this.exitCode === undefined) {
            // Wait for execution to complete - this is critical for JSPI to work properly!
            // The await here allows pending Promises (OPFS operations) to resolve.
            await this.executionPromise;
        }
        return this.exitCode;
    }

    // ===== Terminal Control Methods =====

    getTerminalSize(): TerminalSize {
        return this.terminalSize;
    }

    setTerminalSize(size: TerminalSize): void {
        console.log(`[LazyProcess] setTerminalSize(${size.cols}x${size.rows})`);
        this.terminalSize = size;
        // TODO: Notify running process of resize if applicable
    }

    setRawMode(enabled: boolean): void {
        console.log(`[LazyProcess] setRawMode(${enabled})`);
        this.rawMode = enabled;
    }

    isRawMode(): boolean {
        return this.rawMode;
    }

    sendSignal(signum: number): void {
        console.log(`[LazyProcess] sendSignal(${signum})`);
        // Handle common signals
        if (signum === 2) { // SIGINT
            // Send Ctrl+C to stdin
            this.stdinBuffer.push(new Uint8Array([0x03]));
        } else if (signum === 15) { // SIGTERM
            // Request graceful termination
            this.exitCode = 128 + signum;
        }
    }

    private readFromBuffer(buffer: Uint8Array[], maxBytes: number): Uint8Array {
        if (buffer.length === 0) return new Uint8Array(0);

        const chunks: Uint8Array[] = [];
        let bytesRead = 0;

        while (buffer.length > 0 && bytesRead < maxBytes) {
            const chunk = buffer[0];
            const remaining = maxBytes - bytesRead;

            if (chunk.length <= remaining) {
                chunks.push(buffer.shift()!);
                bytesRead += chunk.length;
            } else {
                chunks.push(chunk.slice(0, remaining));
                buffer[0] = chunk.slice(remaining);
                bytesRead += remaining;
            }
        }

        const result = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    private async executeAsync(): Promise<void> {
        console.log(`[LazyProcess] === EXECUTE START === command: ${this.command}, args:`, this.args);

        console.log(`[LazyProcess] Module loaded, preparing streams`);

        // Concatenate stdin
        const stdinData = this.concatenateBuffers(this.stdinBuffer);
        this.stdinBuffer = [];
        console.log(`[LazyProcess] Stdin data length: ${stdinData.length}`);

        // Create streams with logging
        let stdinOffset = 0;
        const stdinStream = new CustomInputStream({
            blockingRead: (len: bigint): Uint8Array => {
                const remaining = stdinData.length - stdinOffset;
                const toRead = Math.min(Number(len), remaining);
                if (toRead === 0) return new Uint8Array(0);
                const chunk = stdinData.slice(stdinOffset, stdinOffset + toRead);
                stdinOffset += toRead;
                console.log(`[LazyProcess] stdin.blockingRead(${len}) => ${toRead} bytes`);
                return chunk;
            },
        });


        // Write directly to instance buffers so data is available for Rust reads immediately
        const stdoutStream = new CustomOutputStream({
            write: (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stdout.write(${buf.length} bytes):`, JSON.stringify(text));
                this.stdoutBuffer.push(new Uint8Array(buf));
                return BigInt(buf.length);
            },
            blockingWriteAndFlush: (buf: Uint8Array): void => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stdout.blockingWriteAndFlush(${buf.length} bytes):`, JSON.stringify(text));
                this.stdoutBuffer.push(new Uint8Array(buf));
            },
            checkWrite: (): bigint => BigInt(65536),
            blockingFlush: (): void => { },
        });


        const stderrStream = new CustomOutputStream({
            write: (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stderr.write(${buf.length} bytes):`, JSON.stringify(text));
                this.stderrBuffer.push(new Uint8Array(buf));
                return BigInt(buf.length);
            },
            blockingWriteAndFlush: (buf: Uint8Array): void => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stderr.blockingWriteAndFlush(${buf.length} bytes):`, JSON.stringify(text));
                this.stderrBuffer.push(new Uint8Array(buf));
            },
            checkWrite: (): bigint => BigInt(65536),
            blockingFlush: (): void => { },
        });

        try {
            const execEnv: LazyExecEnv = {
                cwd: this.env.cwd,
                vars: this.env.vars,
            };

            // Set up piped streams to capture console.log output
            // This redirects WASI CLI stdout to our buffer instead of the terminal
            const stdoutWrite = (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] piped stdout.write(${buf.length} bytes):`, JSON.stringify(text));
                this.stdoutBuffer.push(new Uint8Array(buf));
                return BigInt(buf.length);
            };
            const stderrWrite = (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] piped stderr.write(${buf.length} bytes):`, JSON.stringify(text));
                this.stderrBuffer.push(new Uint8Array(buf));
                return BigInt(buf.length);
            };
            setPipedStreams(stdoutWrite, stderrWrite);

            // In sync mode (Safari), wrapSyncModule.spawn() already called run() synchronously
            // In JSPI mode (Chrome), spawn() returns a handle that needs to be awaited
            console.log(`[LazyProcess] Calling module.spawn(${this.command}, hasJSPI=${hasJSPI})`);

            const handle = this.module.spawn(
                this.command,
                this.args,
                execEnv,
                stdinStream as never,
                stdoutStream as never,
                stderrStream as never,
            );

            if (hasJSPI) {
                // JSPI mode: await the async resolution
                console.log(`[LazyProcess] JSPI MODE: awaiting handle.resolve()`);
                this.exitCode = await handle.resolve();
            } else {
                // Sync mode: execution already completed synchronously, use poll()
                console.log(`[LazyProcess] SYNC MODE: using handle.poll()`);
                this.exitCode = handle.poll();
            }

            // Clear piped streams to restore normal terminal mode
            clearPipedStreams();
            console.log(`[LazyProcess] exitCode: ${this.exitCode}`);

            console.log(`[LazyProcess] stdoutBuffer count: ${this.stdoutBuffer.length}`);
            console.log(`[LazyProcess] stderrBuffer count: ${this.stderrBuffer.length}`);

            // Log final buffer state
            const totalStdout = this.stdoutBuffer.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
            const totalStderr = this.stderrBuffer.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
            console.log(`[LazyProcess] === EXECUTE END === stdout: ${totalStdout} bytes, stderr: ${totalStderr} bytes, exit: ${this.exitCode}`);
        } catch (error) {
            // Always clear piped streams on error
            clearPipedStreams();
            console.error(`[LazyProcess] EXCEPTION during module execution:`, error);
            this.stderrBuffer.push(new TextEncoder().encode(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`
            ));
            this.exitCode = 1;
        }
    }

    private concatenateBuffers(buffers: Uint8Array[]): Uint8Array {
        const total = buffers.reduce((sum, buf) => sum + buf.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const buf of buffers) {
            result.set(buf, offset);
            offset += buf.length;
        }
        return result;
    }
}

// ============================================================
// WORKER-BASED COMMAND EXECUTION (for interruptible commands)
// ============================================================

// Inline types and constants to avoid cross-package imports
// that cause Vite's worker-import-meta-url plugin to pull in full dependency tree
const CMD_CONTROL = {
    REQUEST_READY: 0,
    RESPONSE_READY: 1,
    DATA_LENGTH: 2,
    EOF: 3,
};

const CMD_BUFFER_LAYOUT = {
    CONTROL_SIZE: 64,
    DATA_OFFSET: 64,
    DATA_SIZE: 64 * 1024,
};

interface CommandSpawnMessage {
    type: 'spawn';
    command: string;
    args: string[];
    env: ExecEnv;
    sharedBuffer: SharedArrayBuffer;
    moduleUrl: string;
}

interface CommandOutputMessage { type: 'stdout' | 'stderr'; data: Uint8Array; }
interface CommandExitMessage { type: 'exit'; code: number; }
interface CommandReadyMessage { type: 'ready'; }
interface CommandErrorMessage { type: 'error'; message: string; }
interface CommandStdinRequestMessage { type: 'stdin-request'; }

type CommandWorkerOutMessage =
    | CommandOutputMessage
    | CommandExitMessage
    | CommandReadyMessage
    | CommandErrorMessage
    | CommandStdinRequestMessage;

/**
 * Get the import URL for a module name (for Worker context).
 * 
 * Workers can't use bare module specifiers. We use Vite's /@fs/ endpoint
 * which serves files from the filesystem with absolute paths.
 * This only works in development mode - in production, these modules
 * would be bundled differently.
 */
function getModuleUrl(moduleName: string): string {
    // Vite's /@fs/ prefix allows serving files from absolute paths
    // The packages are in the workspace root's packages/ directory
    const pkgBase = '/@fs/Users/tjfontaine/Development/web-agent/packages';

    switch (moduleName) {
        case 'tsx-engine':
            return hasJSPI
                ? `${pkgBase}/wasm-tsx/wasm/tsx-engine.js`
                : `${pkgBase}/wasm-tsx/wasm-sync/tsx-engine.js`;
        case 'sqlite-module':
            return hasJSPI
                ? `${pkgBase}/wasm-sqlite/wasm/sqlite-module.js`
                : `${pkgBase}/wasm-sqlite/wasm-sync/sqlite-module.js`;
        case 'edtui-module':
            return hasJSPI
                ? `${pkgBase}/wasm-vim/wasm/edtui-module.js`
                : `${pkgBase}/wasm-vim/wasm-sync/edtui-module.js`;
        case 'ratatui-demo':
            return hasJSPI
                ? `${pkgBase}/wasm-ratatui/wasm/ratatui-demo.js`
                : `${pkgBase}/wasm-ratatui/wasm-sync/ratatui-demo.js`;
        default:
            throw new Error(`No module URL for: ${moduleName}`);
    }
}

/**
 * WorkerProcess - Runs a command in an isolated Web Worker.
 * Supports true interrupt via Worker.terminate().
 * 
 * This is a frontend-specific wrapper that spawns the Worker from
 * the mcp-wasm-server package's zero-import entry point.
 */
class WorkerProcess {
    private worker: Worker | null = null;
    private sharedBuffer: SharedArrayBuffer;
    private controlArray: Int32Array;
    private dataArray: Uint8Array;

    private stdoutBuffer: Uint8Array[] = [];
    private stderrBuffer: Uint8Array[] = [];
    private stdinPendingBuffer: Uint8Array[] = [];  // Buffer for stdin waiting to be sent
    private exitCode: number | undefined = undefined;
    private ready = false;
    private readyPromise: Promise<void>;
    private readyResolve!: () => void;
    private exitPromise: Promise<number>;
    private exitResolve!: (code: number) => void;

    constructor(
        private command: string,
        private args: string[],
        private env: ExecEnv,
    ) {
        this.sharedBuffer = new SharedArrayBuffer(CMD_BUFFER_LAYOUT.CONTROL_SIZE + CMD_BUFFER_LAYOUT.DATA_SIZE);
        this.controlArray = new Int32Array(this.sharedBuffer, 0, 16);
        this.dataArray = new Uint8Array(this.sharedBuffer, CMD_BUFFER_LAYOUT.DATA_OFFSET, CMD_BUFFER_LAYOUT.DATA_SIZE);

        this.readyPromise = new Promise(resolve => { this.readyResolve = resolve; });
        this.exitPromise = new Promise(resolve => { this.exitResolve = resolve; });
    }

    async start(): Promise<void> {
        // Create Worker from frontend-local self-contained entry point
        this.worker = new Worker(
            new URL('./command-worker.ts', import.meta.url),
            { type: 'module' }
        );

        this.worker.onmessage = (event: MessageEvent<CommandWorkerOutMessage>) => {
            const msg = event.data;
            switch (msg.type) {
                case 'ready':
                    this.ready = true;
                    this.readyResolve();
                    break;
                case 'stdout':
                    this.stdoutBuffer.push(new Uint8Array(msg.data));
                    break;
                case 'stderr':
                    this.stderrBuffer.push(new Uint8Array(msg.data));
                    break;
                case 'exit':
                    this.exitCode = msg.code;
                    this.exitResolve(msg.code);
                    // Cleanup Worker
                    if (this.worker) {
                        this.worker.terminate();
                        this.worker = null;
                    }
                    break;
                case 'error':
                    console.error('[WorkerProcess] Error:', msg.message);
                    break;
                case 'stdin-request':
                    // Worker is blocked on Atomics.wait for stdin
                    // Send any buffered stdin data
                    this.flushStdinToWorker();
                    break;
            }
        };

        this.worker.onerror = (error) => {
            console.error('[WorkerProcess] Worker error:', error);
            this.exitCode = 1;
            this.exitResolve(1);
        };

        // Resolve the module URL for this command
        const moduleName = getModuleForCommand(this.command);
        if (!moduleName) {
            throw new Error(`Unknown command for Worker: ${this.command}`);
        }
        const moduleUrl = getModuleUrl(moduleName);

        const spawnMsg: CommandSpawnMessage = {
            type: 'spawn',
            command: this.command,
            args: this.args,
            env: this.env,
            sharedBuffer: this.sharedBuffer,
            moduleUrl,
        };
        this.worker.postMessage(spawnMsg);

        await this.readyPromise;
    }

    // LazyProcess interface methods
    getReadyPollable() {
        return new BasePollable();
    }

    isReady(): boolean {
        return this.ready;
    }

    writeStdin(data: Uint8Array): bigint {
        if (!this.worker || this.exitCode !== undefined) return BigInt(0);

        // Add to pending buffer
        this.stdinPendingBuffer.push(new Uint8Array(data));

        // Try to flush to Worker if it's waiting
        this.flushStdinToWorker();

        return BigInt(data.length);
    }

    /**
     * Flush pending stdin to Worker via SharedArrayBuffer.
     * Worker will be unblocked if it's waiting on Atomics.wait.
     */
    private flushStdinToWorker(): void {
        if (this.stdinPendingBuffer.length === 0) {
            return;
        }

        // Combine all pending data
        const totalLength = this.stdinPendingBuffer.reduce((sum, buf) => sum + buf.length, 0);
        const combined = new Uint8Array(Math.min(totalLength, CMD_BUFFER_LAYOUT.DATA_SIZE));
        let offset = 0;

        while (this.stdinPendingBuffer.length > 0 && offset < combined.length) {
            const chunk = this.stdinPendingBuffer[0];
            const remaining = combined.length - offset;

            if (chunk.length <= remaining) {
                combined.set(chunk, offset);
                offset += chunk.length;
                this.stdinPendingBuffer.shift();
            } else {
                combined.set(chunk.slice(0, remaining), offset);
                this.stdinPendingBuffer[0] = chunk.slice(remaining);
                offset += remaining;
            }
        }

        // Write to SharedArrayBuffer
        this.dataArray.set(combined);
        Atomics.store(this.controlArray, CMD_CONTROL.DATA_LENGTH, offset);
        Atomics.store(this.controlArray, CMD_CONTROL.RESPONSE_READY, 1);
        Atomics.notify(this.controlArray, CMD_CONTROL.RESPONSE_READY);
    }

    closeStdin(): void {
        if (!this.worker) return;
        Atomics.store(this.controlArray, CMD_CONTROL.EOF, 1);
        Atomics.notify(this.controlArray, CMD_CONTROL.RESPONSE_READY);
        this.worker.postMessage({ type: 'stdin', data: new Uint8Array(0), eof: true });
    }

    readStdout(maxBytes: bigint): Uint8Array {
        return this.drainBuffer(this.stdoutBuffer, Number(maxBytes));
    }

    readStderr(maxBytes: bigint): Uint8Array {
        return this.drainBuffer(this.stderrBuffer, Number(maxBytes));
    }

    tryWait(): number | undefined {
        return this.exitCode;
    }

    setRawMode(_enabled: boolean): void {
        // Worker commands don't support raw mode
    }

    sendSignal(signum: number): void {
        if (signum === 2 && this.worker) { // SIGINT
            this.worker.terminate();
            this.exitCode = 130;
            this.exitResolve(130);
        }
    }

    private drainBuffer(buffer: Uint8Array[], maxBytes: number): Uint8Array {
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        while (buffer.length > 0 && bytesRead < maxBytes) {
            const chunk = buffer[0];
            const remaining = maxBytes - bytesRead;
            if (chunk.length <= remaining) {
                chunks.push(buffer.shift()!);
                bytesRead += chunk.length;
            } else {
                chunks.push(chunk.slice(0, remaining));
                buffer[0] = chunk.slice(remaining);
                bytesRead += remaining;
            }
        }
        const result = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}

/**
 * Spawn a command in an isolated Web Worker (interruptible).
 * Uses Worker.terminate() for true SIGINT-like interrupt (exit code 130).
 */
export async function spawnWorkerCommand(
    command: string,
    args: string[],
    env: ExecEnv,
): Promise<LazyProcess> {
    console.log(`[ModuleLoader] spawnWorkerCommand: ${command}`);
    const workerProcess = new WorkerProcess(command, args, env);
    await workerProcess.start();
    // Set prototype to LazyProcess so JCO's instanceof check passes
    // JCO validates: `if (!(ret instanceof LazyProcess))` at the trampoline
    Object.setPrototypeOf(workerProcess, LazyProcess.prototype);
    return workerProcess as unknown as LazyProcess;
}
