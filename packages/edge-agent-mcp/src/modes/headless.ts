/**
 * Headless mode — runs the MCP WASM component natively via wasmtime.
 *
 * Spawns `wasm-tui --mcp-stdio` as a subprocess and pipes JSON-RPC directly.
 * No browser, no network — most predictable mode. Ideal for CI/CD.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { Config } from '../config.js';
import { generateInstructions } from '../negotiate.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../stdio.js';
import { log } from '../stdio.js';

/** The binary name for the native wasmtime runner. */
const RUNNER_BIN = 'wasm-tui';

/**
 * Check if the native wasmtime runner is available on PATH.
 */
export function isHeadlessAvailable(): boolean {
    try {
        execFileSync(RUNNER_BIN, ['--help'], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Create a headless MCP handler that spawns `wasm-tui --mcp-stdio` and
 * forwards all JSON-RPC traffic through it.
 */
export function createHeadlessHandler(config: Config): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
    let child: ChildProcess | null = null;
    let rl: readline.Interface | null = null;
    let requestCounter = 0;
    const pending = new Map<string | number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    const REQUEST_TIMEOUT_MS = 60_000;

    function ensureChild(): void {
        if (child && child.exitCode === null) return;

        const args = ['--mcp-stdio'];

        // Pass work-dir if configured
        const workDir = config.headless.workDir;
        if (workDir && workDir !== '~/.edge-agent/sandbox') {
            args.push('--work-dir', workDir);
        }

        log(`Spawning ${RUNNER_BIN} ${args.join(' ')}`);
        child = spawn(RUNNER_BIN, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        child.on('exit', (code) => {
            log(`${RUNNER_BIN} exited with code ${code}`);
            failAllPending('Subprocess exited');
            child = null;
            rl = null;
        });

        child.on('error', (err) => {
            log(`${RUNNER_BIN} error: ${err.message}`);
            failAllPending(err.message);
            child = null;
            rl = null;
        });

        // Forward subprocess stderr to our stderr
        child.stderr?.on('data', (data: Buffer) => {
            log(`[runner] ${data.toString().trim()}`);
        });

        // Read responses line by line from subprocess stdout
        rl = readline.createInterface({ input: child.stdout! });
        rl.on('line', (line: string) => {
            try {
                const response = JSON.parse(line) as JsonRpcResponse;
                const id = response.id;
                if (id != null) {
                    const p = pending.get(id);
                    if (p) {
                        clearTimeout(p.timer);
                        pending.delete(id);
                        p.resolve(response);
                    }
                }
            } catch {
                log(`Invalid JSON from runner: ${line.slice(0, 100)}`);
            }
        });
    }

    function failAllPending(reason: string): void {
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
        pending.clear();
    }

    function sendAndWait(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        return new Promise((resolve, reject) => {
            ensureChild();

            if (!child?.stdin?.writable) {
                reject(new Error('Subprocess stdin not writable'));
                return;
            }

            const id = request.id ?? ++requestCounter;

            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('Request timed out'));
            }, REQUEST_TIMEOUT_MS);

            pending.set(id, { resolve, reject, timer });

            const line = JSON.stringify({ ...request, id }) + '\n';
            child.stdin.write(line);
        });
    }

    return async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
        const { method, id } = request;

        // Handle initialize locally (add instructions), then forward
        if (method === 'initialize') {
            // Start the subprocess
            try {
                ensureChild();
            } catch {
                // Fall through — will return instructions anyway
            }

            return {
                jsonrpc: '2.0',
                result: {
                    protocolVersion: '2025-03-26',
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'edge-agent', version: '0.1.0' },
                    instructions: generateInstructions({
                        mode: 'headless',
                        sessionUrl: config.headless.workDir,
                        browserConnected: true,
                    }),
                },
                id: id ?? null,
            };
        }

        if (method === 'initialized') return null;
        if (method === 'ping') return { jsonrpc: '2.0', result: {}, id: id ?? null };

        // Forward everything else through the subprocess
        try {
            log(`→ ${method} (headless)`);
            return await sendAndWait(request);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                jsonrpc: '2.0',
                error: { code: -32000, message },
                id: id ?? null,
            };
        }
    };
}
