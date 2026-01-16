/**
 * Command Worker Entry (Frontend)
 * 
 * Self-contained Worker entry point that runs commands in isolation.
 * Receives moduleUrl via postMessage and dynamically imports it with @vite-ignore.
 * 
 * This file is bundled by Vite as a separate Worker bundle.
 * It uses SharedArrayBuffer/Atomics for stdin synchronization.
 */

/// <reference lib="webworker" />

// ============================================================
// INLINE TYPES (no external imports to keep Worker self-contained)
// ============================================================

interface ExecEnv {
    cwd: string;
    vars: [string, string][];
}

interface CommandSpawnMessage {
    type: 'spawn';
    command: string;
    args: string[];
    env: ExecEnv;
    sharedBuffer: SharedArrayBuffer;
    moduleUrl: string;
}

interface CommandStdinMessage {
    type: 'stdin';
    data: Uint8Array;
    eof?: boolean;
}

type CommandWorkerInMessage = CommandSpawnMessage | CommandStdinMessage | { type: 'terminate' };

// Control indices for SharedArrayBuffer
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

// ============================================================
// WORKER STATE
// ============================================================

let controlArray: Int32Array | null = null;
let dataArray: Uint8Array | null = null;
const stdinBuffer: Uint8Array[] = [];
let stdinEof = false;

// ============================================================
// STREAM FACTORIES (inline to avoid imports)
// ============================================================

function createStdinStream() {
    return {
        blockingRead(maxBytes: bigint): Uint8Array {
            if (!controlArray || !dataArray) {
                return new Uint8Array(0);
            }

            // Return buffered data first
            if (stdinBuffer.length > 0) {
                const chunk = stdinBuffer.shift()!;
                const toReturn = chunk.slice(0, Number(maxBytes));
                if (chunk.length > Number(maxBytes)) {
                    stdinBuffer.unshift(chunk.slice(Number(maxBytes)));
                }
                return toReturn;
            }

            if (stdinEof) {
                return new Uint8Array(0);
            }

            // Signal that we need stdin
            Atomics.store(controlArray, CMD_CONTROL.REQUEST_READY, 1);
            Atomics.notify(controlArray, CMD_CONTROL.REQUEST_READY);

            // Wait for response
            Atomics.wait(controlArray, CMD_CONTROL.RESPONSE_READY, 0);
            Atomics.store(controlArray, CMD_CONTROL.RESPONSE_READY, 0);

            // Check EOF
            if (Atomics.load(controlArray, CMD_CONTROL.EOF) === 1) {
                stdinEof = true;
                return new Uint8Array(0);
            }

            // Read data
            const length = Atomics.load(controlArray, CMD_CONTROL.DATA_LENGTH);
            if (length === 0) {
                return new Uint8Array(0);
            }
            const data = new Uint8Array(length);
            data.set(dataArray.slice(0, length));
            return data;
        },
        subscribe(): number { return 0; },
    };
}

function createOutputStream(stream: 'stdout' | 'stderr') {
    return {
        blockingWriteAndFlush(data: Uint8Array): void {
            self.postMessage({ type: stream, data: new Uint8Array(data) });
        },
        subscribe(): number { return 0; },
    };
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

self.addEventListener('message', async (event: MessageEvent<CommandWorkerInMessage>) => {
    const msg = event.data;

    try {
        if (msg.type === 'spawn') {
            // Set up SharedArrayBuffer for stdin
            const buffer = msg.sharedBuffer;
            controlArray = new Int32Array(buffer, 0, 16);
            dataArray = new Uint8Array(buffer, CMD_BUFFER_LAYOUT.DATA_OFFSET, CMD_BUFFER_LAYOUT.DATA_SIZE);

            Atomics.store(controlArray, CMD_CONTROL.REQUEST_READY, 0);
            Atomics.store(controlArray, CMD_CONTROL.RESPONSE_READY, 0);
            Atomics.store(controlArray, CMD_CONTROL.EOF, 0);

            // Dynamic import of module URL passed from main thread
            // @vite-ignore prevents Vite from analyzing this import
            const module = await import(/* @vite-ignore */ msg.moduleUrl);

            // Await $init if present (jco TLA compat)
            if (module.$init) {
                await module.$init;
            }

            self.postMessage({ type: 'ready' });

            // Run the command using the module's spawn/command.run interface
            let exitCode: number;
            if (module.spawn) {
                // CommandModule interface
                const handle = module.spawn(
                    msg.command,
                    msg.args,
                    msg.env,
                    createStdinStream(),
                    createOutputStream('stdout'),
                    createOutputStream('stderr'),
                );
                exitCode = await handle.resolve();
            } else if (module.command?.run) {
                // Direct command interface
                exitCode = module.command.run(
                    msg.command,
                    msg.args,
                    msg.env,
                    createStdinStream(),
                    createOutputStream('stdout'),
                    createOutputStream('stderr'),
                );
            } else {
                throw new Error('Module has no spawn or command.run export');
            }

            self.postMessage({ type: 'exit', code: exitCode });
        } else if (msg.type === 'stdin') {
            if (msg.eof) {
                stdinEof = true;
                if (controlArray) {
                    Atomics.store(controlArray, CMD_CONTROL.EOF, 1);
                    Atomics.notify(controlArray, CMD_CONTROL.RESPONSE_READY);
                }
            } else if (msg.data.length > 0) {
                stdinBuffer.push(new Uint8Array(msg.data));
                if (controlArray) {
                    Atomics.notify(controlArray, CMD_CONTROL.RESPONSE_READY);
                }
            }
        } else if (msg.type === 'terminate') {
            self.close();
        }
    } catch (error) {
        console.error('[CommandWorker] Error:', error);
        self.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : String(error)
        });
    }
});
