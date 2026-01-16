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
    type CommandModule,
    type ExecEnv as LazyExecEnv,
} from './lazy-modules.js';
import { InputStream as CustomInputStream, OutputStream as CustomOutputStream } from '@tjfontaine/wasi-shims';
import { poll } from '@bytecodealliance/preview2-shim/io';

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
 * With JSPI, this can be async and load the module here.
 * 
 * Returns the module name if the command is lazy-loadable.
 */
export async function getLazyModule(command: string): Promise<string | undefined> {
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
 * With JSPI, this is async and will load the module if needed.
 */
export async function spawnLazyCommand(
    moduleName: string,
    command: string,
    args: string[],
    env: ExecEnv,
): Promise<LazyProcess> {
    console.log(`[ModuleLoader] spawnLazyCommand: ${command} (module: ${moduleName})`);

    // Ensure module is loaded (await the async load)
    const module = await loadLazyModule(moduleName);
    console.log(`[ModuleLoader] Module '${moduleName}' loaded for command '${command}'`);

    return new LazyProcess(moduleName, command, args, env, module);
}

/**
 * Spawn an interactive command process (for TUI applications).
 * Automatically sets raw mode and configures terminal size.
 */
export async function spawnInteractive(
    moduleName: string,
    command: string,
    args: string[],
    env: ExecEnv,
    size: TerminalSize,
): Promise<LazyProcess> {
    console.log(`[ModuleLoader] spawnInteractive: ${command} (module: ${moduleName}, size: ${size.cols}x${size.rows})`);

    const module = await loadLazyModule(moduleName);
    console.log(`[ModuleLoader] Module '${moduleName}' loaded for interactive command '${command}'`);

    const process = new LazyProcess(moduleName, command, args, env, module, size);
    process.setRawMode(true); // Interactive mode starts in raw mode
    return process;
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
     * Execute in interactive mode - stdin reads from live buffer.
     */
    private async executeInteractive(): Promise<void> {
        console.log(`[LazyProcess] === INTERACTIVE EXECUTE START === command: ${this.command}`);

        // Create stdin stream that reads from live buffer
        // With JSPI, blockingRead can return a Promise that waits for data
        const stdinStream = new CustomInputStream({
            blockingRead: (len: bigint): Promise<Uint8Array> => {
                // If buffer has data, return it immediately
                const immediate = this.readFromBuffer(this.stdinBuffer, Number(len));
                if (immediate.length > 0) {
                    return Promise.resolve(immediate);
                }

                // No data available - return a Promise that polls for data
                // This allows JSPI to suspend the WASM stack while we wait
                return new Promise<Uint8Array>((resolve) => {
                    const checkInterval = setInterval(() => {
                        const data = this.readFromBuffer(this.stdinBuffer, Number(len));
                        if (data.length > 0) {
                            clearInterval(checkInterval);
                            resolve(data);
                        }
                    }, 16); // Check every 16ms (~60fps)
                });
            },
        });

        // Stdout/stderr write directly to buffers (same as batch mode)
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
                this.stderrBuffer.push(new Uint8Array(buf));
                return BigInt(buf.length);
            },
            blockingWriteAndFlush: (buf: Uint8Array): void => {
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

            console.log(`[LazyProcess] Calling module.spawn(${this.command}, args=${JSON.stringify(this.args)}, cwd=${execEnv.cwd})`);

            // Use new spawn/resolve pattern
            const handle = this.module.spawn(
                this.command,
                this.args,
                execEnv,
                stdinStream as never,
                stdoutStream as never,
                stderrStream as never,
            );

            // Wait for command to complete
            this.exitCode = await handle.resolve();

            console.log(`[LazyProcess] handle.resolve() returned exitCode: ${this.exitCode}`);
            console.log(`[LazyProcess] stdoutBuffer count: ${this.stdoutBuffer.length}`);
            console.log(`[LazyProcess] stderrBuffer count: ${this.stderrBuffer.length}`);

            // Log final buffer state
            const totalStdout = this.stdoutBuffer.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
            const totalStderr = this.stderrBuffer.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
            console.log(`[LazyProcess] === EXECUTE END === stdout: ${totalStdout} bytes, stderr: ${totalStderr} bytes, exit: ${this.exitCode}`);
        } catch (error) {
            console.error(`[LazyProcess] EXCEPTION during module.spawn():`, error);
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
// WORKER-BASED PROCESS (for interruptible commands)
// ============================================================

import {
    CMD_CONTROL,
    CMD_BUFFER_LAYOUT,
    type CommandWorkerInMessage,
    type CommandSpawnMessage,
    type CommandOutputMessage,
    type CommandExitMessage,
    type CommandReadyMessage,
    type CommandErrorMessage,
    type CommandStdinRequestMessage,
} from './command-worker-entry.js';

// Union type for all Worker output messages
type CommandWorkerOutMessage = CommandOutputMessage | CommandExitMessage | CommandReadyMessage | CommandErrorMessage | CommandStdinRequestMessage;

/**
 * WorkerProcess - Runs a command in an isolated Web Worker.
 * Supports true interrupt via Worker.terminate().
 */
export class WorkerProcess {
    private worker: Worker | null = null;
    private sharedBuffer: SharedArrayBuffer;
    private controlArray: Int32Array;
    private dataArray: Uint8Array;

    private stdoutBuffer: Uint8Array[] = [];
    private stderrBuffer: Uint8Array[] = [];
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
        // Create shared buffer for stdin communication
        this.sharedBuffer = new SharedArrayBuffer(CMD_BUFFER_LAYOUT.CONTROL_SIZE + CMD_BUFFER_LAYOUT.DATA_SIZE);
        this.controlArray = new Int32Array(this.sharedBuffer, 0, 16);
        this.dataArray = new Uint8Array(this.sharedBuffer, CMD_BUFFER_LAYOUT.DATA_OFFSET, CMD_BUFFER_LAYOUT.DATA_SIZE);

        // Initialize promises
        this.readyPromise = new Promise(resolve => { this.readyResolve = resolve; });
        this.exitPromise = new Promise(resolve => { this.exitResolve = resolve; });
    }

    /**
     * Start the worker and begin command execution.
     */
    async start(): Promise<void> {
        console.log(`[WorkerProcess] Starting worker for: ${this.command}`);

        // Spawn worker using zero-import entry
        this.worker = new Worker(
            new URL('./command-worker-entry.ts', import.meta.url),
            { type: 'module' }
        );

        // Handle messages from worker
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
                    break;

                case 'error':
                    console.error(`[WorkerProcess] Error: ${msg.message}`);
                    break;

                case 'stdin-request':
                    // Worker wants stdin - notify via Atomics
                    // Data should already be in shared buffer from writeStdin
                    Atomics.notify(this.controlArray, CMD_CONTROL.RESPONSE_READY);
                    break;
            }
        };

        this.worker.onerror = (error) => {
            console.error('[WorkerProcess] Worker error:', error);
            this.exitCode = 1;
            this.exitResolve(1);
        };

        // Send spawn message - Worker will resolve module internally
        const spawnMsg: CommandSpawnMessage = {
            type: 'spawn',
            command: this.command,
            args: this.args,
            env: this.env,
            sharedBuffer: this.sharedBuffer,
        };
        this.worker.postMessage(spawnMsg);

        // Wait for ready
        await this.readyPromise;
        console.log(`[WorkerProcess] Worker ready for: ${this.command}`);
    }

    // ===== LazyProcess-compatible interface =====

    getReadyPollable() {
        return new (class {
            ready() { return true; }
            block() { }
        })();
    }

    isReady(): boolean {
        return this.ready;
    }

    writeStdin(data: Uint8Array): bigint {
        // Write to shared buffer
        this.dataArray.set(data.slice(0, CMD_BUFFER_LAYOUT.DATA_SIZE));
        Atomics.store(this.controlArray, CMD_CONTROL.DATA_LENGTH, data.length);
        Atomics.store(this.controlArray, CMD_CONTROL.RESPONSE_READY, 1);
        Atomics.notify(this.controlArray, CMD_CONTROL.RESPONSE_READY);
        return BigInt(data.length);
    }

    closeStdin(): void {
        Atomics.store(this.controlArray, CMD_CONTROL.EOF, 1);
        Atomics.notify(this.controlArray, CMD_CONTROL.RESPONSE_READY);
    }

    readStdout(maxBytes: bigint): Uint8Array {
        return this.readFromBuffer(this.stdoutBuffer, Number(maxBytes));
    }

    readStderr(maxBytes: bigint): Uint8Array {
        return this.readFromBuffer(this.stderrBuffer, Number(maxBytes));
    }

    async tryWait(): Promise<number | undefined> {
        if (this.exitCode !== undefined) {
            return this.exitCode;
        }
        // Give worker a chance to complete
        await new Promise(resolve => setTimeout(resolve, 0));
        return this.exitCode;
    }

    getTerminalSize() {
        return { cols: 80, rows: 24 };
    }

    setTerminalSize(_size: { cols: number; rows: number }): void {
        // TODO: Forward to worker if needed
    }

    setRawMode(_enabled: boolean): void {
        // TODO: Forward to worker
    }

    isRawMode(): boolean {
        return false;
    }

    /**
     * Send signal to process. SIGINT (2) terminates the worker.
     */
    sendSignal(signum: number): void {
        console.log(`[WorkerProcess] sendSignal(${signum})`);

        if (signum === 2 && this.worker) { // SIGINT
            // Terminate worker - immediate exit
            this.worker.terminate();
            this.worker = null;
            this.exitCode = 130; // 128 + SIGINT
            this.exitResolve(130);
        } else if (signum === 15 && this.worker) { // SIGTERM
            // Graceful termination request
            this.worker.postMessage({ type: 'terminate' } as CommandWorkerInMessage);
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
}

/**
 * Spawn a command in an isolated Worker (interruptible).
 * The Worker automatically loads the appropriate module for the command.
 */
export async function spawnWorkerCommand(
    command: string,
    args: string[],
    env: ExecEnv,
): Promise<WorkerProcess> {
    const process = new WorkerProcess(command, args, env);
    await process.start();
    return process;
}
