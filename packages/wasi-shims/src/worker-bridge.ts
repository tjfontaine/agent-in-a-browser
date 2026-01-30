/**
 * Worker Bridge Controller (Main Thread)
 * 
 * Manages the WASM worker for non-JSPI browsers (Safari).
 * Handles async operations on the main thread and forwards results
 * to the worker via SharedArrayBuffer + Atomics.notify().
 */

import type { Terminal } from 'ghostty-web';
import { STDIN_CONTROL, HTTP_CONTROL } from './worker-constants';

// ============================================================
// TYPES
// ============================================================

// Transport handler for routing HTTP requests (e.g., to sandbox worker via postMessage)
type HttpTransportHandler = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
) => Promise<{ status: number; body: Uint8Array }>;

interface WorkerReadyMessage {
    type: 'ready';
}

interface WorkerStdinRequestMessage {
    type: 'stdin-request';
    maxLen: number;
}

interface WorkerHttpRequestMessage {
    type: 'http-request';
    method: string;
    url: string;
    headers: Record<string, string>;
    body: number[] | null;
}

interface WorkerStartedMessage {
    type: 'started';
    module: string;
}

interface WorkerErrorMessage {
    type: 'error';
    message: string;
}

interface WorkerTerminalOutputMessage {
    type: 'terminal-output';
    data: string;
}

type WorkerOutboundMessage =
    | WorkerReadyMessage
    | WorkerStdinRequestMessage
    | WorkerHttpRequestMessage
    | WorkerStartedMessage
    | WorkerErrorMessage
    | WorkerTerminalOutputMessage;

// Buffer layout (must match wasm-worker.ts)
const CONTROL_SIZE = 64;
const STDIN_BUFFER_OFFSET = 64;
const STDIN_BUFFER_SIZE = 4096;
const HTTP_BUFFER_OFFSET = STDIN_BUFFER_OFFSET + STDIN_BUFFER_SIZE;
const HTTP_BUFFER_SIZE = 60 * 1024;
const TOTAL_BUFFER_SIZE = HTTP_BUFFER_OFFSET + HTTP_BUFFER_SIZE;

// ============================================================
// WORKER BRIDGE CLASS
// ============================================================

export class WorkerBridge {
    private worker: Worker | null = null;
    private sharedBuffer: SharedArrayBuffer;
    private opfsSharedBuffer: SharedArrayBuffer;
    private controlArray: Int32Array;
    private stdinDataArray: Uint8Array;
    private httpDataArray: Uint8Array;
    private terminal: Terminal | null = null;
    private mcpTransport: HttpTransportHandler | null = null;
    private ready = false;
    private readyPromise: Promise<void>;
    private readyResolve: (() => void) | null = null;
    private stdinBuffer: Uint8Array[] = [];

    // Batched terminal output to prevent Safari event loop flooding
    private terminalOutputBuffer: string[] = [];
    private terminalOutputFlushScheduled = false;
    private workerUrl: URL | null = null;

    constructor(terminal?: Terminal, options?: { mcpTransport?: HttpTransportHandler; workerUrl?: URL }) {
        this.terminal = terminal || null;
        this.mcpTransport = options?.mcpTransport || null;
        this.workerUrl = options?.workerUrl || null;

        // Create SharedArrayBuffer for stdin/http communication
        this.sharedBuffer = new SharedArrayBuffer(TOTAL_BUFFER_SIZE);
        this.controlArray = new Int32Array(this.sharedBuffer, 0, CONTROL_SIZE / 4);
        this.stdinDataArray = new Uint8Array(this.sharedBuffer, STDIN_BUFFER_OFFSET, STDIN_BUFFER_SIZE);
        this.httpDataArray = new Uint8Array(this.sharedBuffer, HTTP_BUFFER_OFFSET, HTTP_BUFFER_SIZE);

        // Create SharedArrayBuffer for OPFS worker communication
        // Must be created in main thread since WebKit workers don't have SharedArrayBuffer
        const opfsBufferSize = 64 + 64 * 1024; // 64 bytes control + 64KB data
        this.opfsSharedBuffer = new SharedArrayBuffer(opfsBufferSize);

        // Ready promise for async initialization
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
        });
    }

    /**
     * Start the worker and initialize communication.
     * @param workerUrl Optional URL to the worker script. Overrides constructor option.
     */
    async start(workerUrl?: URL): Promise<void> {
        const url = workerUrl || this.workerUrl;
        if (!url) {
            throw new Error('[WorkerBridge] No worker URL provided. Pass workerUrl to constructor or start().');
        }

        // Spawn the worker
        this.worker = new Worker(url, { type: 'module' });

        // Set up message handler
        this.worker.onmessage = (e: MessageEvent<WorkerOutboundMessage>) => {
            this.handleWorkerMessage(e.data);
        };

        this.worker.onerror = (e) => {
            console.error('[WorkerBridge] Worker error:', e.message || e.filename || e);
        };

        // Initialize worker with shared buffers
        // Both buffers must be created in main thread for WebKit compatibility
        this.worker.postMessage({
            type: 'init',
            sharedBuffer: this.sharedBuffer,
            opfsSharedBuffer: this.opfsSharedBuffer
        });

        // Wait for worker to be ready
        await this.readyPromise;

        // Wire up terminal input if provided
        if (this.terminal) {
            this.terminal.onData((data: string) => {
                this.handleTerminalInput(data);
            });
        }

        console.log('[WorkerBridge] Worker ready');
    }

    /**
     * Handle messages from the worker.
     */
    private handleWorkerMessage(msg: WorkerOutboundMessage): void {
        switch (msg.type) {
            case 'ready':
                this.ready = true;
                if (this.readyResolve) {
                    this.readyResolve();
                }
                break;

            case 'stdin-request':
                this.handleStdinRequest(msg.maxLen);
                break;

            case 'http-request':
                this.handleHttpRequest(msg);
                break;

            case 'started':
                console.log(`[WorkerBridge] WASM module started: ${msg.module}`);
                break;

            case 'error':
                console.error(`[WorkerBridge] Worker error: ${msg.message}`);
                break;

            case 'terminal-output':
                // Route stdout from WasmWorker to Ghostty terminal (Safari sync mode)
                // Batch writes to prevent event loop flooding and allow render frames
                if (this.terminal && msg.data) {
                    this.terminalOutputBuffer.push(msg.data);
                    this.scheduleTerminalFlush();
                }
                break;
        }
    }

    /**
     * Schedule a flush of batched terminal output.
     * Uses requestAnimationFrame to allow Safari's render loop to run between
     * message bursts, preventing event loop starvation.
     */
    private scheduleTerminalFlush(): void {
        if (this.terminalOutputFlushScheduled) {
            return; // Already scheduled
        }
        this.terminalOutputFlushScheduled = true;

        // Use requestAnimationFrame to batch writes and allow render frames
        requestAnimationFrame(() => {
            this.flushTerminalOutput();
        });
    }

    /**
     * Flush all buffered terminal output in a single write.
     */
    private flushTerminalOutput(): void {
        this.terminalOutputFlushScheduled = false;

        if (this.terminalOutputBuffer.length === 0 || !this.terminal) {
            return;
        }

        // Concatenate all buffered output and write once
        const combined = this.terminalOutputBuffer.join('');
        this.terminalOutputBuffer = [];

        this.terminal.write(combined);
    }

    /**
     * Handle terminal input from ghostty-web.
     */
    private handleTerminalInput(data: string): void {
        console.log(`[WorkerBridge] handleTerminalInput called, len=${data.length}, data=${JSON.stringify(data.slice(0, 20))}`);
        const bytes = new TextEncoder().encode(data);

        // Check if worker is waiting for stdin
        const requestReady = Atomics.load(this.controlArray, STDIN_CONTROL.REQUEST_READY);
        console.log(`[WorkerBridge] REQUEST_READY=${requestReady}`);

        if (requestReady === 1) {
            // Worker is waiting - send directly
            console.log('[WorkerBridge] Worker waiting, sending stdin directly');
            this.sendStdinToWorker(bytes);
        } else {
            // Buffer for later
            console.log('[WorkerBridge] Worker not waiting, buffering stdin');
            this.stdinBuffer.push(bytes);
        }
    }

    /**
     * Handle stdin request from worker.
     */
    private handleStdinRequest(maxLen: number): void {
        if (this.stdinBuffer.length > 0) {
            // We have buffered data - send it
            const data = this.stdinBuffer.shift()!;
            this.sendStdinToWorker(data.slice(0, maxLen));
        }
        // Otherwise, wait for terminal input (handleTerminalInput will send it)
    }

    /**
     * Send stdin data to worker via SharedArrayBuffer.
     */
    private sendStdinToWorker(data: Uint8Array): void {
        console.log(`[WorkerBridge] sendStdinToWorker: ${data.length} bytes`);
        // Copy data to shared buffer
        this.stdinDataArray.set(data);
        Atomics.store(this.controlArray, STDIN_CONTROL.DATA_LENGTH, data.length);
        Atomics.store(this.controlArray, STDIN_CONTROL.RESPONSE_READY, 1);
        const notified = Atomics.notify(this.controlArray, STDIN_CONTROL.RESPONSE_READY);
        console.log(`[WorkerBridge] Atomics.notify returned: ${notified}`);
    }

    /**
     * Handle HTTP request from worker with streaming response.
     * Streams body chunks via SharedArrayBuffer as they arrive from fetch.
     */
    private async handleHttpRequest(msg: WorkerHttpRequestMessage): Promise<void> {
        try {
            let response: Response;
            let useStreaming = true;

            // Check if this is an MCP request that should go through the transport handler
            const isMcpRequest = this.mcpTransport &&
                msg.url.includes('localhost') &&
                msg.url.includes('/mcp');

            if (isMcpRequest && this.mcpTransport) {
                console.log('[WorkerBridge] Routing MCP request via transport:', msg.method, msg.url);
                // MCP transport doesn't support streaming yet - use legacy path
                const transportResponse = await this.mcpTransport(
                    msg.method,
                    msg.url,
                    msg.headers,
                    msg.body ? new Uint8Array(msg.body) : null
                );
                // Send as single chunk for MCP requests (legacy compatible)
                this.sendHttpChunk(transportResponse.status, [], transportResponse.body, true);
                return;
            }

            // Direct fetch with streaming for non-MCP requests
            response = await fetch(msg.url, {
                method: msg.method,
                headers: msg.headers,
                body: msg.body ? new Uint8Array(msg.body) : undefined
            });

            // Extract headers
            const responseHeaders: [string, string][] = [];
            response.headers.forEach((value, name) => {
                responseHeaders.push([name, value]);
            });

            // Send headers first via postMessage (variable-length data)
            this.worker?.postMessage({
                type: 'http-headers',
                status: response.status,
                headers: responseHeaders
            });

            // Check if we can stream the response body
            if (!response.body) {
                // No body - signal done immediately
                console.log('[WorkerBridge] HTTP response has no body, signaling done');
                this.sendHttpChunk(response.status, [], new Uint8Array(0), true);
                return;
            }

            // Stream body chunks directly to worker as they arrive
            console.log('[WorkerBridge] Streaming HTTP response body...');
            const reader = response.body.getReader();
            let totalBytes = 0;

            try {
                while (true) {
                    const { value, done } = await reader.read();

                    if (done || !value || value.length === 0) {
                        // Signal EOF - empty chunk with done=true
                        this.sendHttpChunk(response.status, [], new Uint8Array(0), true);
                        console.log('[WorkerBridge] HTTP streaming complete, total bytes:', totalBytes);
                        break;
                    }

                    // Handle chunks larger than buffer size by splitting
                    let offset = 0;
                    while (offset < value.length) {
                        const chunkSize = Math.min(value.length - offset, HTTP_BUFFER_SIZE);
                        const chunk = value.slice(offset, offset + chunkSize);

                        // Send this chunk (done=false since more data may follow)
                        this.sendHttpChunk(response.status, [], chunk, false);

                        // Wait for worker to consume this chunk before sending next
                        await this.waitForChunkConsumption();

                        offset += chunkSize;
                        totalBytes += chunkSize;
                    }
                }
            } finally {
                reader.releaseLock();
            }

        } catch (err) {
            console.error('[WorkerBridge] HTTP request failed:', err);
            // Signal error (status 0, empty body, done)
            this.sendHttpChunk(0, [], new Uint8Array(0), true);
        }
    }

    /**
     * Send an HTTP chunk to the worker via SharedArrayBuffer.
     */
    private sendHttpChunk(
        status: number,
        _headers: [string, string][],
        chunk: Uint8Array,
        done: boolean
    ): void {
        // Copy chunk to shared buffer
        if (chunk.length > 0) {
            this.httpDataArray.set(chunk.slice(0, HTTP_BUFFER_SIZE));
        }

        // Set metadata in control array
        Atomics.store(this.controlArray, HTTP_CONTROL.STATUS_CODE, status);
        Atomics.store(this.controlArray, HTTP_CONTROL.BODY_LENGTH, Math.min(chunk.length, HTTP_BUFFER_SIZE));
        Atomics.store(this.controlArray, HTTP_CONTROL.DONE, done ? 1 : 0);
        Atomics.store(this.controlArray, HTTP_CONTROL.RESPONSE_READY, 1);
        Atomics.notify(this.controlArray, HTTP_CONTROL.RESPONSE_READY);

        console.log(`[WorkerBridge] Sent HTTP chunk: ${chunk.length} bytes, done=${done}`);
    }

    /**
     * Wait for the worker to consume the current chunk.
     * Uses Atomics.waitAsync for non-blocking wait on main thread.
     */
    private async waitForChunkConsumption(): Promise<void> {
        // Wait for worker to signal it consumed the chunk
        // Use polling since Atomics.waitAsync may not be available everywhere
        const maxWait = 30000; // 30 second timeout
        const pollInterval = 1;
        let waited = 0;

        while (waited < maxWait) {
            const consumed = Atomics.load(this.controlArray, HTTP_CONTROL.CHUNK_CONSUMED);
            if (consumed === 1) {
                // Reset the flag for next chunk
                Atomics.store(this.controlArray, HTTP_CONTROL.CHUNK_CONSUMED, 0);
                return;
            }
            // Yield to event loop briefly
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            waited += pollInterval;
        }

        console.warn('[WorkerBridge] Timeout waiting for chunk consumption');
    }

    /**
     * Run a WASM module in the worker.
     */
    runModule(module: 'tui' | 'mcp', args?: string[]): void {
        if (!this.worker || !this.ready) {
            throw new Error('Worker not ready');
        }

        this.worker.postMessage({
            type: 'run',
            module,
            args
        });
    }

    /**
     * Write output to terminal (if connected).
     */
    writeToTerminal(data: string): void {
        if (this.terminal) {
            this.terminal.write(data);
        }
    }

    /**
     * Handle terminal resize event - inject directly via SharedArrayBuffer.
     * We can't use postMessage because the worker is blocked on Atomics.wait.
     */
    handleResize(cols: number, rows: number): void {
        if (!this.controlArray || !this.stdinDataArray) {
            console.log('[WorkerBridge] handleResize called but no SharedArrayBuffer');
            return;
        }
        console.log(`[WorkerBridge] Injecting resize via SharedArrayBuffer: ${cols}x${rows}`);

        // Create DECSLPP escape sequence: CSI 8 ; rows ; cols t
        const resizeSequence = `\x1b[8;${rows};${cols}t`;
        const bytes = new TextEncoder().encode(resizeSequence);

        // Inject directly into stdin buffer (same as sendStdinToWorker)
        this.stdinDataArray.set(bytes);
        Atomics.store(this.controlArray, STDIN_CONTROL.DATA_LENGTH, bytes.length);
        Atomics.store(this.controlArray, STDIN_CONTROL.RESPONSE_READY, 1);
        const notified = Atomics.notify(this.controlArray, STDIN_CONTROL.RESPONSE_READY);
        console.log(`[WorkerBridge] Resize injected, Atomics.notify returned: ${notified}`);
    }

    /**
     * Terminate the worker.
     */
    terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.ready = false;
        }
    }

    /**
     * Check if worker is ready.
     */
    isReady(): boolean {
        return this.ready;
    }
}

// Export singleton for simple usage
let defaultBridge: WorkerBridge | null = null;

export function getWorkerBridge(): WorkerBridge | null {
    return defaultBridge;
}

export function createWorkerBridge(terminal?: Terminal): WorkerBridge {
    defaultBridge = new WorkerBridge(terminal);
    return defaultBridge;
}
