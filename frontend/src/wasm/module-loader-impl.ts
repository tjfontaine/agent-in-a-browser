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
import { CustomInputStream, CustomOutputStream } from './streams.js';
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
        const stdinStream = new CustomInputStream({
            blockingRead: (len: bigint): Uint8Array => {
                // Read from live buffer - this is called on-demand
                return this.readFromBuffer(this.stdinBuffer, Number(len));
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
        console.log(`[LazyProcess] readStdout(${maxBytes}) called, buffer.length=${this.stdoutBuffer.length}`);
        const result = this.readFromBuffer(this.stdoutBuffer, Number(maxBytes));
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
        // Wait for execution to complete before checking exit code
        // JSPI must be configured for this function via --async-imports 'mcp:module-loader/loader#try-wait'
        if (this.executionPromise) {
            await this.executionPromise;
            this.executionPromise = null;
        }
        console.log(`[LazyProcess] tryWait() => ${this.exitCode}`);
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
