/**
 * Module Loader Implementation
 * 
 * Provides the mcp:module-loader/loader interface that the core WASM runtime
 * imports. Uses eager loading to have modules ready before WIT calls.
 */

import {
    LAZY_COMMANDS,
    getLoadedModuleSync,
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

// Track initialization state
let modulesInitialized = false;

/**
 * Initialize all lazy modules at startup (eager loading).
 * This should be called during WASM initialization.
 */
export async function initializeLazyModules(): Promise<void> {
    if (modulesInitialized) return;

    console.log('[ModuleLoader] Eagerly loading all lazy modules...');
    const startTime = performance.now();

    try {
        // Load all modules in parallel
        await Promise.all([
            loadLazyModule('tsx-engine').catch(e => {
                console.warn('[ModuleLoader] Failed to load tsx-engine:', e);
            }),
            loadLazyModule('sqlite-module').catch(e => {
                console.warn('[ModuleLoader] Failed to load sqlite-module:', e);
            }),
        ]);

        const elapsed = performance.now() - startTime;
        console.log(`[ModuleLoader] All modules loaded in ${elapsed.toFixed(0)}ms`);
        modulesInitialized = true;
    } catch (e) {
        console.error('[ModuleLoader] Failed to initialize modules:', e);
    }
}

// Start loading immediately on module import
const initPromise = initializeLazyModules();

/**
 * Check if a command should be handled by a lazy module.
 */
export function getLazyModule(command: string): string | undefined {
    const moduleName = LAZY_COMMANDS[command];
    if (moduleName) {
        console.log(`[ModuleLoader] Command '${command}' -> module '${moduleName}'`);
        return moduleName;
    }
    return undefined;
}

/**
 * Spawn a lazy command process.
 */
export function spawnLazyCommand(
    module: string,
    command: string,
    args: string[],
    env: ExecEnv,
): LazyProcess {
    console.log(`[ModuleLoader] spawnLazyCommand: ${command} (module: ${module})`);
    return new LazyProcess(module, command, args, env);
}

/**
 * ReadyPollable - A pollable that is immediately ready.
 * Since modules are eagerly loaded, this just checks the cache.
 */
class ReadyPollable extends BasePollable {
    private moduleName: string;
    private _module: CommandModule | null = null;
    private _error: Error | null = null;

    constructor(moduleName: string) {
        super();
        this.moduleName = moduleName;

        // Check if already loaded (should be, since we eager load)
        this._module = getLoadedModuleSync(moduleName);
        if (!this._module) {
            console.warn(`[ReadyPollable] Module '${moduleName}' not loaded - waiting for init`);
        }
    }

    ready(): boolean {
        if (!this._module) {
            this._module = getLoadedModuleSync(this.moduleName);
        }
        return this._module !== null;
    }

    block(): void {
        // Module should already be loaded from eager loading
        if (!this._module) {
            this._module = getLoadedModuleSync(this.moduleName);
        }
        if (!this._module) {
            console.error(`[ReadyPollable] Module '${this.moduleName}' not loaded after block()`);
            this._error = new Error(`Module '${this.moduleName}' not available`);
        }
    }

    getModule(): CommandModule | null {
        return this._module;
    }

    getError(): Error | null {
        return this._error;
    }
}

/**
 * LazyProcess - Handle for a running lazy command with streaming I/O.
 */
export class LazyProcess {
    private stdinBuffer: Uint8Array[] = [];
    private stdinClosed = false;
    private stdoutBuffer: Uint8Array[] = [];
    private stderrBuffer: Uint8Array[] = [];
    private exitCode: number | undefined = undefined;
    private started = false;

    private moduleName: string;
    private command: string;
    private args: string[];
    private env: ExecEnv;

    private readyPollable: ReadyPollable;

    constructor(
        moduleName: string,
        command: string,
        args: string[],
        env: ExecEnv,
    ) {
        this.moduleName = moduleName;
        this.command = command;
        this.args = args;
        this.env = env;

        // Module should already be loaded from eager loading
        this.readyPollable = new ReadyPollable(moduleName);
    }

    getReadyPollable(): ReadyPollable {
        return this.readyPollable;
    }

    isReady(): boolean {
        return this.readyPollable.ready();
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
            this.execute();
        }
        console.log(`[LazyProcess] closeStdin() complete, stdoutBuffer.length=${this.stdoutBuffer.length}, stderrBuffer.length=${this.stderrBuffer.length}`);
    }

    readStdout(maxBytes: bigint): Uint8Array {
        const result = this.readFromBuffer(this.stdoutBuffer, Number(maxBytes));
        if (result.length > 0) {
            const text = new TextDecoder().decode(result);
            console.log(`[LazyProcess] readStdout(${maxBytes}) => ${result.length} bytes:`, JSON.stringify(text));
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

    tryWait(): number | undefined {
        console.log(`[LazyProcess] tryWait() => ${this.exitCode}`);
        return this.exitCode;
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

    private execute(): void {
        console.log(`[LazyProcess] === EXECUTE START === command: ${this.command}, args:`, this.args);

        const module = this.readyPollable.getModule();
        const loadError = this.readyPollable.getError();

        if (loadError) {
            console.error(`[LazyProcess] Load error:`, loadError);
            this.stderrBuffer.push(new TextEncoder().encode(`Error: ${loadError.message}\n`));
            this.exitCode = 127;
            return;
        }

        if (!module) {
            console.error(`[LazyProcess] Module '${this.moduleName}' not loaded`);
            this.stderrBuffer.push(new TextEncoder().encode(`Module '${this.moduleName}' not loaded\n`));
            this.exitCode = 127;
            return;
        }

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

        const stdoutChunks: Uint8Array[] = [];
        const stdoutStream = new CustomOutputStream({
            write: (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stdout.write(${buf.length} bytes):`, JSON.stringify(text));
                stdoutChunks.push(new Uint8Array(buf));
                return BigInt(buf.length);
            },
            blockingWriteAndFlush: (buf: Uint8Array): void => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stdout.blockingWriteAndFlush(${buf.length} bytes):`, JSON.stringify(text));
                stdoutChunks.push(new Uint8Array(buf));
            },
            checkWrite: (): bigint => BigInt(65536),
            blockingFlush: (): void => { },
        });

        const stderrChunks: Uint8Array[] = [];
        const stderrStream = new CustomOutputStream({
            write: (buf: Uint8Array): bigint => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stderr.write(${buf.length} bytes):`, JSON.stringify(text));
                stderrChunks.push(new Uint8Array(buf));
                return BigInt(buf.length);
            },
            blockingWriteAndFlush: (buf: Uint8Array): void => {
                const text = new TextDecoder().decode(buf);
                console.log(`[LazyProcess] stderr.blockingWriteAndFlush(${buf.length} bytes):`, JSON.stringify(text));
                stderrChunks.push(new Uint8Array(buf));
            },
            checkWrite: (): bigint => BigInt(65536),
            blockingFlush: (): void => { },
        });

        try {
            const execEnv: LazyExecEnv = {
                cwd: this.env.cwd,
                vars: this.env.vars,
            };

            console.log(`[LazyProcess] Calling module.run(${this.command}, args=${JSON.stringify(this.args)}, cwd=${execEnv.cwd})`);

            this.exitCode = module.run(
                this.command,
                this.args,
                execEnv,
                stdinStream as never,
                stdoutStream as never,
                stderrStream as never,
            );

            console.log(`[LazyProcess] module.run() returned exitCode: ${this.exitCode}`);
            console.log(`[LazyProcess] stdoutChunks count: ${stdoutChunks.length}`);
            console.log(`[LazyProcess] stderrChunks count: ${stderrChunks.length}`);

            this.stdoutBuffer.push(...stdoutChunks);
            this.stderrBuffer.push(...stderrChunks);

            // Log final buffer state
            const totalStdout = stdoutChunks.reduce((sum, c) => sum + c.length, 0);
            const totalStderr = stderrChunks.reduce((sum, c) => sum + c.length, 0);
            console.log(`[LazyProcess] === EXECUTE END === stdout: ${totalStdout} bytes, stderr: ${totalStderr} bytes, exit: ${this.exitCode}`);
        } catch (error) {
            console.error(`[LazyProcess] EXCEPTION during module.run():`, error);
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

// Export the init promise for callers who need to wait
export { initPromise };
