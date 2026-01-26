// Import stream classes from shared module to avoid duplication
import { InputStream, OutputStream, ReadyPollable } from './streams';
// Import JSPI detection for automatic sync mode
import { hasJSPI } from './execution-mode';
// Import HuggingFace transformers.js transport for local LLM inference
import { isWebLLMUrl, handleWebLLMRequest } from './hf-transport.js';

// Type for WASM Result-like return values
type WasmResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

// ============ Transport Interceptor ============
// Allows routing requests to different backends (e.g., sandbox worker for local MCP)

/**
 * Transport response shape.
 */
export type TransportResponse = { status: number; headers: [string, Uint8Array][]; body: Uint8Array };

/**
 * Sync transport result marker.
 * Used in Safari/non-JSPI mode to signal that the response is already available
 * and should NOT be treated as a Promise (avoids microtask queue deadlock).
 * 
 * The $sync discriminant makes this unambiguous - regular objects won't have it.
 */
export type SyncTransportResult = { $sync: true; value: TransportResponse };

/**
 * Async transport result - standard Promise path for JSPI mode.
 */
export type AsyncTransportResult = Promise<TransportResponse>;

/**
 * Combined transport result type.
 * Handlers return either:
 * - SyncTransportResult with $sync marker (Safari) - value is immediately available
 * - AsyncTransportResult Promise (Chrome/JSPI) - await to get response
 */
export type TransportResult = SyncTransportResult | AsyncTransportResult;

/**
 * Type guard to check if a transport result is synchronous (new $sync marker).
 */
export function isSyncTransportResult(result: TransportResult | { syncValue: TransportResponse }): result is SyncTransportResult {
    return typeof result === 'object' && result !== null && '$sync' in result && (result as SyncTransportResult).$sync === true;
}

/**
 * Transport handler type.
 * In JSPI mode: returns Promise<TransportResponse> that resolves asynchronously
 * In sync mode: returns { $sync: true, value: TransportResponse } with already-available data
 * 
 * @deprecated The old { syncValue: ... } pattern is also supported for backward compatibility
 */
type TransportHandler = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
) => TransportResult | { syncValue: TransportResponse };

let transportHandler: TransportHandler | null = null;
let syncModeTransport = false;

/**
 * Set a custom transport handler for intercepting HTTP requests.
 * The handler receives (method, url, headers, body) and returns a response.
 * This allows routing requests to web workers instead of making actual HTTP calls.
 * 
 * @param handler - The transport handler function
 * @param isSyncMode - If true, transport returns already-resolved Promise via blockingHttpRequest.
 *                     This signals that we should NOT use async lazy body streams (Safari can't await).
 */
export function setTransportHandler(handler: TransportHandler | null, isSyncMode = false): void {
    transportHandler = handler;
    syncModeTransport = isSyncMode;
}

// ============ Streaming Transport Handler ============
// For streaming HTTP responses chunk-by-chunk in sync mode (Safari)

/**
 * Streaming HTTP chunk result.
 */
export interface StreamingHttpChunk {
    status: number;           // HTTP status (only valid on first chunk)
    headers: [string, Uint8Array][]; // Response headers (only valid on first chunk)
    chunk: Uint8Array;        // Body chunk data
    done: boolean;            // True if this is the last chunk (EOF)
}

/**
 * Streaming transport handler type - yields chunks as generator.
 */
type StreamingTransportHandler = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
) => Generator<StreamingHttpChunk, void, unknown>;

let streamingTransportHandler: StreamingTransportHandler | null = null;

/**
 * Set a streaming transport handler for chunk-by-chunk HTTP responses.
 * Used in sync mode (Safari) to enable streaming without JSPI.
 */
export function setStreamingTransportHandler(handler: StreamingTransportHandler | null): void {
    streamingTransportHandler = handler;
}

/**
 * Create an InputStream that reads from a streaming transport generator.
 * Each blockingRead() call pulls the next chunk via the generator.
 * This enables streaming HTTP responses in sync mode (Safari).
 */
export function createSyncStreamingInputStream(
    generator: Generator<StreamingHttpChunk, void, unknown>
): unknown {
    let currentChunk: Uint8Array = new Uint8Array(0);
    let offset = 0;
    let done = false;
    let firstChunkMeta: { status: number; headers: [string, Uint8Array][] } | null = null;

    return new InputStream({
        read(len: bigint): Uint8Array {
            // Non-blocking read - return buffered data or empty
            if (offset < currentChunk.length) {
                const n = Math.min(Number(len), currentChunk.length - offset);
                const result = currentChunk.slice(offset, offset + n);
                offset += n;
                return result;
            }
            return new Uint8Array(0);
        },

        blockingRead(len: bigint): Uint8Array {
            // If we have buffered data, return that first
            if (offset < currentChunk.length) {
                const n = Math.min(Number(len), currentChunk.length - offset);
                const result = currentChunk.slice(offset, offset + n);
                offset += n;
                return result;
            }

            // If stream is done, return empty
            if (done) {
                return new Uint8Array(0);
            }

            // Get next chunk from generator (this blocks via Atomics.wait in worker)
            const next = generator.next();
            if (next.done) {
                done = true;
                return new Uint8Array(0);
            }

            const chunkResult = next.value;

            // Store first chunk metadata for headers/status
            if (firstChunkMeta === null) {
                firstChunkMeta = { status: chunkResult.status, headers: chunkResult.headers };
            }

            if (chunkResult.done && chunkResult.chunk.length === 0) {
                done = true;
                return new Uint8Array(0);
            }

            // Set current chunk and return first portion
            currentChunk = chunkResult.chunk;
            offset = 0;
            done = chunkResult.done && chunkResult.chunk.length === 0;

            const n = Math.min(Number(len), currentChunk.length);
            const result = currentChunk.slice(0, n);
            offset = n;
            return result;
        }
    });
}

/**
 * Create an InputStream from a streaming generator when the first chunk has already been extracted.
 * This is used when we need to pull status/headers from the first chunk before creating the stream.
 */
export function createSyncStreamingInputStreamFromChunks(
    firstChunkData: Uint8Array | null,
    firstChunkDone: boolean,
    generator: Generator<StreamingHttpChunk, void, unknown>
): unknown {
    let currentChunk: Uint8Array = firstChunkData || new Uint8Array(0);
    let offset = 0;
    let done = firstChunkDone && (firstChunkData === null || firstChunkData.length === 0);
    let firstChunkConsumed = false;

    return new InputStream({
        read(len: bigint): Uint8Array {
            // Non-blocking read - return buffered data or empty
            if (offset < currentChunk.length) {
                const n = Math.min(Number(len), currentChunk.length - offset);
                const result = currentChunk.slice(offset, offset + n);
                offset += n;
                return result;
            }
            return new Uint8Array(0);
        },

        blockingRead(len: bigint): Uint8Array {
            // If we have buffered data, return that first
            if (offset < currentChunk.length) {
                const n = Math.min(Number(len), currentChunk.length - offset);
                const result = currentChunk.slice(offset, offset + n);
                offset += n;
                return result;
            }

            // If stream is done, return empty
            if (done) {
                return new Uint8Array(0);
            }

            // Mark first chunk as consumed (it was pre-extracted for headers)
            firstChunkConsumed = true;

            // Get next chunk from generator (this blocks via Atomics.wait in worker)
            const next = generator.next();
            if (next.done) {
                done = true;
                return new Uint8Array(0);
            }

            const chunkResult = next.value;

            if (chunkResult.done && chunkResult.chunk.length === 0) {
                done = true;
                return new Uint8Array(0);
            }

            // Set current chunk and return first portion
            currentChunk = chunkResult.chunk;
            offset = 0;
            done = chunkResult.done && chunkResult.chunk.length === 0;

            const n = Math.min(Number(len), currentChunk.length);
            const result = currentChunk.slice(0, n);
            offset = n;
            return result;
        }
    });
}

/**
 * Check if a URL should be intercepted by the transport handler.
 * Returns true for localhost MCP endpoints.
 */
function shouldIntercept(url: string): boolean {
    // Intercept localhost MCP calls and WebLLM local inference
    return (url.includes('localhost') && url.includes('/mcp')) || isWebLLMUrl(url);
}

// ============ CORS Proxy Configuration ============
// Domains that should be routed through the CORS proxy
const CORS_PROXY_DOMAINS = [
    'mcp.stripe.com',
    'access.stripe.com',
    'api.githubcopilot.com',
    'github.com',
    'generativelanguage.googleapis.com',  // Google Gemini API
    // Note: httpbin.org supports CORS natively, no proxy needed
];

// The CORS proxy endpoint (same origin, different path)
const CORS_PROXY_PATH = '/cors-proxy';

/**
 * Check if a URL should be routed through the CORS proxy.
 * Returns true for external MCP servers in the allowlist.
 */
function shouldProxyViaCors(url: string): boolean {
    try {
        const parsed = new URL(url);
        return CORS_PROXY_DOMAINS.includes(parsed.hostname);
    } catch {
        return false;
    }
}

/**
 * Rewrite a URL to go through the CORS proxy.
 */
function getCorsProxyUrl(targetUrl: string): string {
    // Use same origin as current page
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}${CORS_PROXY_PATH}?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Create an InputStream from a byte array
 * This allows the WASM component to read the request body
 */
export function createInputStreamFromBytes(bytes: Uint8Array): unknown {
    let offset = 0;

    return new InputStream({
        read(len: bigint): Uint8Array {
            const remaining = bytes.length - offset;
            if (remaining <= 0) {
                return new Uint8Array(0);
            }
            const toRead = Math.min(Number(len), remaining);
            const chunk = bytes.slice(offset, offset + toRead);
            offset += toRead;
            return chunk;
        },
        blockingRead(len: bigint): Uint8Array {
            // Same as read for our synchronous use case
            const remaining = bytes.length - offset;
            if (remaining <= 0) {
                return new Uint8Array(0);
            }
            const toRead = Math.min(Number(len), remaining);
            const chunk = bytes.slice(offset, offset + toRead);
            offset += toRead;
            return chunk;
        }
    });
}

/**
 * Create an InputStream that reads from a fetch ReadableStreamReader
 * This enables true streaming via JSPI - each read suspends until data arrives
 */
export function createStreamingInputStream(reader: ReadableStreamDefaultReader<Uint8Array>): unknown {
    // Buffer for leftover bytes when we read more than requested
    let buffer: Uint8Array = new Uint8Array(0);
    let done = false;

    return new InputStream({
        read(len: bigint): Uint8Array {
            // Non-blocking read - return buffered data or empty
            if (buffer.length > 0) {
                const n = Math.min(Number(len), buffer.length);
                const result = buffer.slice(0, n);
                buffer = buffer.slice(n);
                return result;
            }
            return new Uint8Array(0);
        },

        async blockingRead(len: bigint): Promise<Uint8Array> {
            // If we have buffered data, return that first
            if (buffer.length > 0) {
                const n = Math.min(Number(len), buffer.length);
                const result = buffer.slice(0, n);
                buffer = buffer.slice(n);
                return result;
            }

            // If stream is done, return empty
            if (done) {
                return new Uint8Array(0);
            }

            // Read from the stream - this suspends via JSPI until data arrives
            const { value, done: streamDone } = await reader.read();
            done = streamDone;

            if (!value || value.length === 0) {
                return new Uint8Array(0);
            }

            // If we got more than requested, buffer the rest
            const n = Number(len);
            if (value.length > n) {
                buffer = value.slice(n);
                return value.slice(0, n);
            }

            return value;
        }
    });
}

/**
 * Create an InputStream that lazily initiates a fetch on first read.
 * This pattern allows returning a FutureIncomingResponse immediately
 * while the actual network request is deferred until body consumption.
 * JSPI suspension happens in blockingRead, not in Pollable.block().
 */
export function createLazyFetchStream(url: string, options: RequestInit): unknown {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let fetchPromise: Promise<Response> | null = null;
    let buffer: Uint8Array = new Uint8Array(0);
    let done = false;
    let fetchError: Error | null = null;

    // Lazily start the fetch
    const ensureFetch = (): Promise<Response> => {
        if (!fetchPromise) {
            fetchPromise = fetch(url, options);
        }
        return fetchPromise;
    };

    return new InputStream({
        read(len: bigint): Uint8Array {
            // Non-blocking read - return buffered data or empty
            if (buffer.length > 0) {
                const n = Math.min(Number(len), buffer.length);
                const result = buffer.slice(0, n);
                buffer = buffer.slice(n);
                return result;
            }
            return new Uint8Array(0);
        },

        async blockingRead(len: bigint): Promise<Uint8Array> {
            // If we have buffered data, return that first
            if (buffer.length > 0) {
                const n = Math.min(Number(len), buffer.length);
                const result = buffer.slice(0, n);
                buffer = buffer.slice(n);
                return result;
            }

            // If stream is done, return empty
            if (done) {
                return new Uint8Array(0);
            }

            // If we had a fetch error, return empty
            if (fetchError) {
                return new Uint8Array(0);
            }

            try {
                // Get the response (lazily starts fetch)
                if (!reader) {
                    const response = await ensureFetch();

                    if (!response.body) {
                        done = true;
                        return new Uint8Array(0);
                    }
                    reader = response.body.getReader();
                }

                // Read from the stream - this suspends via JSPI until data arrives
                const { value, done: streamDone } = await reader.read();
                done = streamDone;

                if (!value || value.length === 0) {
                    return new Uint8Array(0);
                }

                // If we got more than requested, buffer the rest
                const n = Number(len);
                if (value.length > n) {
                    buffer = value.slice(n);
                    return value.slice(0, n);
                }

                return value;
            } catch (err) {
                fetchError = err as Error;
                done = true;
                return new Uint8Array(0);
            }
        }
    });
}

/**
 * Create an InputStream that lazily awaits a Promise<Uint8Array> on first read.
 * This pattern allows returning a FutureIncomingResponse immediately
 * while the actual data resolution is deferred until body consumption.
 * JSPI suspension happens in blockingRead, not in Pollable.block().
 */
export function createLazyBufferStream(dataPromise: Promise<Uint8Array>): unknown {
    let data: Uint8Array | null = null;
    let offset = 0;
    let done = false;
    let error: Error | null = null;

    return new InputStream({
        read(len: bigint): Uint8Array {
            // Non-blocking read - return buffered data or empty
            if (data && offset < data.length) {
                const n = Math.min(Number(len), data.length - offset);
                const result = data.slice(offset, offset + n);
                offset += n;
                if (offset >= data.length) {
                    done = true;
                }
                return result;
            }
            return new Uint8Array(0);
        },

        async blockingRead(len: bigint): Promise<Uint8Array> {
            // If we have data, return from it
            if (data && offset < data.length) {
                const n = Math.min(Number(len), data.length - offset);
                const result = data.slice(offset, offset + n);
                offset += n;
                if (offset >= data.length) {
                    done = true;
                }
                return result;
            }

            // If done, return empty
            if (done) {
                return new Uint8Array(0);
            }

            // If we had an error, return empty
            if (error) {
                return new Uint8Array(0);
            }

            try {
                // Await the data promise (lazily starts resolution)
                // This suspends via JSPI until data is ready
                data = await dataPromise;

                if (!data || data.length === 0) {
                    done = true;
                    return new Uint8Array(0);
                }

                // Return first chunk
                const n = Math.min(Number(len), data.length);
                const result = data.slice(0, n);
                offset = n;
                if (offset >= data.length) {
                    done = true;
                }
                return result;
            } catch (err) {
                error = err as Error;
                done = true;
                return new Uint8Array(0);
            }
        }
    });
}

export class Fields {
    private _fields: Map<string, Uint8Array[]>;

    constructor(fields?: [string, Uint8Array[]][]) {
        this._fields = new Map(fields || []);
    }

    get(name: string): Uint8Array[] {
        return this._fields.get(name.toLowerCase()) || [];
    }

    has(name: string): boolean {
        return this._fields.has(name.toLowerCase());
    }

    set(name: string, value: Uint8Array[]) {
        this._fields.set(name.toLowerCase(), value);
    }

    /**
     * Append a value to a field (WASI HTTP spec method)
     * Returns void on success, jco wraps in Result automatically
     */
    append(name: string, value: Uint8Array): void {
        const key = name.toLowerCase();
        const existing = this._fields.get(key) || [];
        existing.push(value);
        this._fields.set(key, existing);
    }

    /**
     * Delete a field (WASI HTTP spec method)
     * Returns void on success, jco wraps in Result automatically
     */
    delete(name: string): void {
        this._fields.delete(name.toLowerCase());
    }

    /**
     * Clone fields (WASI HTTP spec method)
     */
    clone(): Fields {
        const newFields = new Fields();
        for (const [name, values] of this._fields) {
            newFields._fields.set(name, [...values]);
        }
        return newFields;
    }

    /**
     * Returns entries flattened - one [name, value] pair per value
     * This matches the WASI HTTP Fields.entries() interface
     */
    entries(): [string, Uint8Array][] {
        const result: [string, Uint8Array][] = [];
        for (const [name, values] of this._fields) {
            for (const value of values) {
                result.push([name, value]);
            }
        }
        return result;
    }

    static fromList(entries: [string, Uint8Array[]][]): Fields {
        return new Fields(entries);
    }
}

export class FutureTrailers {
    subscribe(): unknown { return new ReadyPollable(); }
    get() { return { tag: 'ok', val: undefined }; }
}

export class IncomingBody {
    private _stream: unknown;
    private _consumed: boolean = false;

    constructor(streamOrBytes: unknown | Uint8Array) {
        if (streamOrBytes instanceof Uint8Array) {
            this._stream = createInputStreamFromBytes(streamOrBytes);
        } else {
            this._stream = streamOrBytes;
        }
    }

    /**
     * Get the body stream. Throws if already consumed.
     * JCO wraps the return in Result automatically.
     */
    stream(): unknown {
        if (this._consumed) {
            throw new Error('Body stream already consumed');
        }
        this._consumed = true;
        return this._stream;
    }

    static finish(_body: IncomingBody): FutureTrailers {
        return new FutureTrailers();
    }
}

export class IncomingRequest {
    private _method: string;
    private _pathWithQuery: string;
    private _scheme: string;
    private _authority: string;
    private _headers: Fields;
    private _body: IncomingBody;
    private _consumed: boolean = false;

    constructor(method: string, pathWithQuery: string, scheme: string, authority: string, headers: Fields, body: IncomingBody) {
        this._method = method;
        this._pathWithQuery = pathWithQuery;
        this._scheme = scheme;
        this._authority = authority;
        this._headers = headers;
        this._body = body;
    }

    method(): string {
        return this._method;
    }

    pathWithQuery(): string | undefined {
        return this._pathWithQuery;
    }

    scheme(): string | undefined {
        return this._scheme;
    }

    authority(): string | undefined {
        return this._authority;
    }

    headers(): Fields {
        return this._headers;
    }

    consume(): IncomingBody {
        if (this._consumed) {
            throw new Error('Body already consumed');
        }
        this._consumed = true;
        return this._body;
    }
}

export class OutgoingBody {
    private _stream: unknown;
    public _onFinish?: () => void;

    constructor(stream: unknown) {
        this._stream = stream;
    }

    write(): unknown {
        return this._stream;
    }

    static finish(body: OutgoingBody, _trailers?: Fields) {
        if (body._onFinish) {
            body._onFinish();
        }
    }
}

export class OutgoingResponse {
    private _statusCode: number;
    private _headers: Fields;
    private _body: OutgoingBody;
    public _bodyChunks: Uint8Array[] = [];
    public _onBodyFinished?: () => void;
    public _onChunk?: (chunk: Uint8Array) => void;

    constructor(headers: Fields, onChunk?: (chunk: Uint8Array) => void) {
        this._headers = headers;
        this._statusCode = 200;
        this._onChunk = onChunk;
        this._body = new OutgoingBody(new OutputStream({
            write: (bytes: Uint8Array) => {
                this._bodyChunks.push(bytes);
                if (this._onChunk) {
                    this._onChunk(bytes);
                }
                return BigInt(bytes.length);
            },
            flush: () => { },
            blockingFlush: () => { },
            blockingWriteAndFlush: (bytes: Uint8Array) => {
                this._bodyChunks.push(bytes);
                if (this._onChunk) {
                    this._onChunk(bytes);
                }
            },
            checkWrite: () => BigInt(1024 * 1024)
        }));
        this._body._onFinish = () => {
            if (this._onBodyFinished) {
                this._onBodyFinished();
            }
        };
    }

    statusCode(): number {
        return this._statusCode;
    }

    setStatusCode(code: number) {
        this._statusCode = code;
    }

    headers(): Fields {
        return this._headers;
    }

    body(): OutgoingBody {
        return this._body;
    }

    /**
     * Get the collected response body as a string
     */
    getBodyAsString(): string {
        const totalLength = this._bodyChunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this._bodyChunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder().decode(result);
    }

    /**
     * Check if streaming is enabled
     */
    isStreaming(): boolean {
        return this._onChunk !== undefined;
    }
}

export class ResponseOutparam {
    private _callback: (response: WasmResult<OutgoingResponse>) => void;
    private _response: OutgoingResponse | null = null;

    constructor(callback: (response: WasmResult<OutgoingResponse>) => void) {
        this._callback = callback;
    }

    /**
     * Get the response after it has been set
     */
    getResponse(): OutgoingResponse | null {
        return this._response;
    }

    static set(param: ResponseOutparam, response: WasmResult<OutgoingResponse>) {
        if (response.tag === 'ok') {
            param._response = response.val;
        }
        if (param && param._callback) {
            param._callback(response);
        } else {
            console.warn('ResponseOutparam.set called but no callback attached', param, response);
        }
    }
}

/**
 * Helper to create a complete IncomingRequest for JSON-RPC
 */
export function createJsonRpcRequest(body: string): IncomingRequest {
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(body);

    const headers = new Fields();
    headers.set('content-type', [encoder.encode('application/json')]);
    headers.set('content-length', [encoder.encode(String(bodyBytes.length))]);
    headers.set('accept', [encoder.encode('application/json')]);

    const incomingBody = new IncomingBody(bodyBytes);

    return new IncomingRequest(
        'POST',
        '/mcp',
        'http',
        'localhost',
        headers,
        incomingBody
    );
}

// ============ Outgoing HTTP Handler ============

// AsyncPollable extends ReadyPollable from ./streams (imported at top of file)

/**
 * AsyncPollable - a pollable that waits on a Promise
 * Must extend ReadyPollable for JCO instanceof checks to pass.
 */
class AsyncPollable extends ReadyPollable {
    private _ready: boolean = false;
    private _promise: Promise<void>;

    constructor(promise: Promise<void>) {
        super();
        console.log('[AsyncPollable] constructor called');
        this._promise = promise;
        promise.then(() => {
            console.log('[AsyncPollable] promise resolved, setting ready=true');
            this._ready = true;
        }).catch((err) => {
            console.log('[AsyncPollable] promise rejected:', err);
            this._ready = true; // Ready on error too
        });
    }

    override ready(): boolean {
        console.log('[AsyncPollable] ready() called, returning:', this._ready);
        return this._ready;
    }

    override async block(): Promise<void> {
        console.log('[AsyncPollable] block() called, awaiting promise...');
        await this._promise;
        console.log('[AsyncPollable] block() completed');
    }
}

/**
 * Symbol to identify FutureIncomingResponse instances across module boundaries.
 * Using Symbol.for() ensures the same symbol is used even with module duplication.
 */
const FUTURE_INCOMING_RESPONSE_SYMBOL = Symbol.for('wasi-http:FutureIncomingResponse');

/**
 * Check if an object is a FutureIncomingResponse.
 * Uses Symbol-based check that survives module duplication.
 */
export function isFutureIncomingResponse(obj: unknown): obj is FutureIncomingResponse {
    return typeof obj === 'object' && obj !== null && (obj as Record<symbol, boolean>)[FUTURE_INCOMING_RESPONSE_SYMBOL] === true;
}

/**
 * Represents a future HTTP response that may be pending.
 * Supports both sync (pre-resolved) and async (Promise-based) responses.
 * 
 * For streaming responses, pass { status, headers, bodyStream } format
 * where bodyStream is created by createStreamingInputStream.
 */
type ResolvedResponse = { status: number; headers: [string, Uint8Array][]; body: Uint8Array };
type StreamingResponse = { status: number; headers: [string, Uint8Array][]; bodyStream: unknown };

export class FutureIncomingResponse {
    // Symbol marker for cross-module instanceof check
    readonly [FUTURE_INCOMING_RESPONSE_SYMBOL] = true;

    private _result: WasmResult<IncomingResponse> | null = null;
    private _promise: Promise<void> | null = null;
    private _pollable: AsyncPollable | ReadyPollable;

    constructor(resolvedDataOrPromise: ResolvedResponse | StreamingResponse | Promise<ResolvedResponse | StreamingResponse>) {
        if (resolvedDataOrPromise instanceof Promise) {
            // Async case - resolve later
            this._promise = resolvedDataOrPromise.then((resolvedData) => {
                this._setResult(resolvedData);
            }).catch((err) => {
                // ErrorCode is a variant - internal-error takes an optional string message
                this._result = { tag: 'err', val: { tag: 'internal-error', val: String(err) } };
            });
            this._pollable = new AsyncPollable(this._promise);
        } else {
            // Sync case - already resolved
            this._setResult(resolvedDataOrPromise);
            this._pollable = new ReadyPollable();
        }
    }

    private _setResult(resolvedData: ResolvedResponse | StreamingResponse) {
        const headers = new Fields();
        for (const [name, value] of resolvedData.headers) {
            const existing = headers.get(name);
            headers.set(name, [...existing, value]);
        }

        // Support both pre-loaded body (Uint8Array) and streaming body (InputStream)
        let body: IncomingBody;
        if ('bodyStream' in resolvedData) {
            // Streaming body - pass the InputStream directly
            body = new IncomingBody(resolvedData.bodyStream);
        } else {
            // Pre-loaded body
            body = new IncomingBody(resolvedData.body);
        }

        this._result = { tag: 'ok', val: new IncomingResponse(resolvedData.status, headers, body) };
    }

    subscribe(): unknown {
        console.log('[FutureIncomingResponse] subscribe() called, returning pollable:', this._pollable);
        return this._pollable;
    }

    /**
     * Get the response. Returns:
     * - undefined: not ready yet (sync mode - call subscribe().block() first)
     * - { tag: 'ok', val: result }: success
     * - Promise<...>: JSPI mode - await for result
     * 
     * This method works in BOTH sync and JSPI modes:
     * - Sync mode: After subscribe().block(), _result is set, returns immediately
     * - JSPI mode: If _result not ready, returns Promise that resolves to result
     */
    get(): { tag: 'ok', val: WasmResult<IncomingResponse> } | undefined | Promise<{ tag: 'ok', val: WasmResult<IncomingResponse> } | undefined> {
        console.log('[FutureIncomingResponse] get() called, result:', this._result ? 'ready' : 'not ready');

        // If result is already available, return immediately (works for both modes)
        // WIT spec: option<result<result<incoming-response, error-code>>>
        // - outer result wraps the inner _result for "at most once" call semantics
        if (this._result !== null) {
            console.log('[FutureIncomingResponse] _result.tag:', this._result.tag);
            console.log('[FutureIncomingResponse] _result.val:', this._result.val?.constructor?.name);
            const returnVal = { tag: 'ok' as const, val: this._result };
            console.log('[FutureIncomingResponse] returning:', JSON.stringify({
                tag: returnVal.tag,
                valTag: returnVal.val?.tag,
                valValClass: returnVal.val?.val?.constructor?.name
            }));
            return returnVal;
        }

        // Result not ready
        // In JSPI mode: return Promise that jco can await
        // In sync mode: return undefined - jco expects poll()/block() to be called first
        if (hasJSPI && this._promise) {
            console.log('[FutureIncomingResponse] JSPI mode - returning Promise');
            return this._promise.then(() => {
                if (this._result === null) {
                    return undefined;
                }
                return { tag: 'ok', val: this._result };
            });
        }

        // Sync mode: result not ready, return undefined (option::none)
        // The caller should use subscribe().block() first to wait for the result
        console.log('[FutureIncomingResponse] Sync mode - returning undefined (not ready)');
        return undefined;
    }
}

/**
 * IncomingResponse - represents a received HTTP response
 */
export class IncomingResponse {
    private _status: number;
    private _headers: Fields;
    private _body: IncomingBody;
    private _consumed: boolean = false;

    constructor(status: number, headers: Fields, body: IncomingBody) {
        this._status = status;
        this._headers = headers;
        this._body = body;
    }

    status(): number {
        return this._status;
    }

    headers(): Fields {
        return this._headers;
    }

    consume(): IncomingBody {
        if (this._consumed) {
            throw new Error('Body already consumed');
        }
        this._consumed = true;
        return this._body;
    }
}

/**
 * OutgoingRequest - represents an outgoing HTTP request
 */
export class OutgoingRequest {
    private _method: { tag: string, val?: string };
    private _scheme: { tag: string, val?: string } | null;
    private _authority: string | null;
    private _pathWithQuery: string | null;
    private _headers: Fields;
    private _body: OutgoingBody | null = null;
    public _bodyChunks: Uint8Array[] = [];

    constructor(headers: Fields) {
        this._headers = headers;
        this._method = { tag: 'get' };
        this._scheme = null;
        this._authority = null;
        this._pathWithQuery = null;
    }

    method(): { tag: string, val?: string } {
        return this._method;
    }

    setMethod(method: { tag: string, val?: string }): void {
        this._method = method;
    }

    scheme(): { tag: string, val?: string } | null {
        return this._scheme;
    }

    setScheme(scheme: { tag: string, val?: string } | null): void {
        this._scheme = scheme;
    }

    authority(): string | null {
        return this._authority;
    }

    setAuthority(authority: string | null): void {
        this._authority = authority;
    }

    pathWithQuery(): string | null {
        return this._pathWithQuery;
    }

    setPathWithQuery(path: string | null): void {
        this._pathWithQuery = path;
    }

    headers(): Fields {
        return this._headers;
    }

    body(): OutgoingBody {
        if (this._body) {
            throw new Error('Body already retrieved');
        }
        // Create a proper OutputStream that collects body chunks
        const outputStream = new OutputStream({
            write: (bytes: Uint8Array) => {
                this._bodyChunks.push(bytes);
                return BigInt(bytes.length);
            },
            flush: () => { },
            blockingFlush: () => { },
            blockingWriteAndFlush: (bytes: Uint8Array) => {
                this._bodyChunks.push(bytes);
            },
            checkWrite: () => BigInt(1024 * 1024)
        });
        this._body = new OutgoingBody(outputStream);
        return this._body;
    }

    /**
     * Get collected body as bytes
     */
    getBodyBytes(): Uint8Array {
        const totalLength = this._bodyChunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this._bodyChunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}

/**
 * RequestOptions - optional parameters for HTTP requests
 */
export class RequestOptions {
    private _connectTimeout: bigint | null = null;
    private _firstByteTimeout: bigint | null = null;
    private _betweenBytesTimeout: bigint | null = null;

    connectTimeout(): bigint | null { return this._connectTimeout; }
    setConnectTimeout(t: bigint | null) { this._connectTimeout = t; }
    firstByteTimeout(): bigint | null { return this._firstByteTimeout; }
    setFirstByteTimeout(t: bigint | null) { this._firstByteTimeout = t; }
    betweenBytesTimeout(): bigint | null { return this._betweenBytesTimeout; }
    setBetweenBytesTimeout(t: bigint | null) { this._betweenBytesTimeout = t; }
}

/**
 * The outgoing handler - makes HTTP requests.
 * 
 * For localhost MCP requests: Uses transport handler if set (routes to sandbox worker)
 * For other requests: Uses synchronous XMLHttpRequest
 * 
 * Returns FutureIncomingResponse directly (sync return, but may be pending async)
 * Throws on error (jco catches and converts to Result.err)
 */
export const outgoingHandler = {
    handle(request: OutgoingRequest, _options: RequestOptions | null): FutureIncomingResponse {
        // Build the URL
        const scheme = request.scheme();
        // DEBUG: Log raw scheme value
        console.log('[http] DEBUG raw scheme:', JSON.stringify(scheme));

        // Handle WASI scheme tags - may be 'HTTPS', 'https', or { tag: 'https' }
        // Preserve custom schemes like 'wasm' for local MCP routing
        let schemeStr = 'http';
        if (scheme) {
            const tag = (typeof scheme === 'string' ? scheme : scheme.tag) || '';
            const tagLower = tag.toLowerCase();
            console.log('[http] DEBUG scheme tag:', tag, 'tagLower:', tagLower);

            if (tagLower === 'https') {
                schemeStr = 'https';
            } else if (tagLower === 'http') {
                schemeStr = 'http';
            } else if (tagLower === 'other' && typeof scheme === 'object' && 'val' in scheme) {
                // Custom scheme from WASI { tag: 'other', val: 'wasm' }
                schemeStr = (scheme as { tag: string; val: string }).val || 'http';
                console.log('[http] DEBUG using other.val:', schemeStr);
            } else if (tagLower && tagLower !== 'other') {
                // Non-standard scheme passed directly (e.g., 'wasm')
                schemeStr = tagLower;
                console.log('[http] DEBUG using tagLower:', schemeStr);
            }
        }
        const authority = request.authority() || '';
        const path = request.pathWithQuery() || '/';
        const url = `${schemeStr}://${authority}${path}`;
        console.log('[http] DEBUG constructed URL:', url);

        // Build method
        const methodObj = request.method();
        const method = methodObj.tag === 'other' ? (methodObj.val || 'GET') : methodObj.tag.toUpperCase();

        // Build headers
        const headers: Record<string, string> = {};
        for (const [name, value] of request.headers().entries()) {
            headers[name] = new TextDecoder().decode(value);
        }

        // Get the request body
        const bodyBytes = request.getBodyBytes();
        const body = bodyBytes.length > 0 ? bodyBytes : null;

        // ============ Synchronous Local MCP (wasm://) ============
        // For wasm:// URLs, use synchronous local MCP handler if available
        // This enables sync mode to work with local MCP servers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globalWindow = typeof window !== 'undefined' ? window as any : null;

        if (url.startsWith('wasm://') && globalWindow?._wasmMcpRequestSync) {
            console.log('[http] Using sync local MCP transport:', method, url);
            try {
                // Call local MCP handler synchronously
                const syncResult = globalWindow._wasmMcpRequestSync(method, url, headers, body) as {
                    status: number;
                    headers: [string, Uint8Array][];
                    body: Uint8Array;
                };

                // Return FutureIncomingResponse with resolved data (not Promise)
                // This triggers the sync path in FutureIncomingResponse constructor
                return new FutureIncomingResponse({
                    status: syncResult.status,
                    headers: syncResult.headers,
                    body: syncResult.body
                });
            } catch (err) {
                console.error('[http] Sync local MCP error:', err);
                // Return error response
                const errorBody = new TextEncoder().encode(String(err));
                return new FutureIncomingResponse({
                    status: 500,
                    headers: [['content-type', new TextEncoder().encode('text/plain')]],
                    body: errorBody
                });
            }
        }

        // ============ iOS Native Transport ============
        // Route ALL HTTP requests through Swift URLSession to avoid CORS
        // This is detected by the presence of window._iosHttpRequest set by web-runtime.html
        if (globalWindow?._iosHttpRequest) {
            console.log('[http] Using iOS native transport:', method, url);

            // Make async request through Swift bridge
            // The Promise will be resolved when Swift calls _httpCallback
            const iosPromise = globalWindow._iosHttpRequest(method, url, headers, body) as Promise<{
                status: number;
                headers: [string, Uint8Array][];
                body: Uint8Array;
            }>;

            // Return FutureIncomingResponse with the iOS promise
            return new FutureIncomingResponse(
                iosPromise.then((response) => ({
                    status: response.status,
                    headers: response.headers,
                    body: response.body
                }))
            );
        }


        // Route WebLLM requests to local inference engine
        if (isWebLLMUrl(url)) {
            console.log('[http] Routing to WebLLM:', method, url);

            // WebLLM always uses async path (requires model loading)
            const webllmPromise = handleWebLLMRequest(method, url, headers, body);

            // Use lazy body stream for streaming responses
            const bodyStream = createLazyBufferStream(
                webllmPromise.then((r) => r.body)
            );

            // Return async response with lazy body stream
            return new FutureIncomingResponse(
                webllmPromise.then((r) => ({
                    status: r.status,
                    headers: r.headers,
                    bodyStream: bodyStream
                }))
            );
        }

        // Check if we should route through transport handler
        // Prefer streaming transport handler over legacy sync transport
        if (shouldIntercept(url)) {
            console.log('[http] Intercepting request:', method, url);

            // Use streaming transport handler if available (enables true streaming)
            if (streamingTransportHandler) {
                console.log('[http] Using streaming transport handler');

                // Create streaming generator
                const generator = streamingTransportHandler(method, url, headers, body);

                // Get first chunk to extract status/headers
                const firstResult = generator.next();
                if (firstResult.done) {
                    // Empty response
                    return new FutureIncomingResponse({
                        status: 200,
                        headers: [],
                        body: new Uint8Array(0)
                    });
                }

                const firstChunk = firstResult.value;
                const status = firstChunk.status;
                const responseHeaders = firstChunk.headers;

                // Create streaming body that yields remaining chunks
                const bodyStream = createSyncStreamingInputStreamFromChunks(
                    firstChunk.done ? null : firstChunk.chunk,
                    firstChunk.done,
                    generator
                );

                console.log('[http] Streaming response: status=', status);
                return new FutureIncomingResponse({
                    status,
                    headers: responseHeaders,
                    bodyStream
                });
            }

            // Fallback to legacy transport handler
            if (transportHandler) {
                console.log('[http] Routing via legacy transport handler:', method, url);

                // Call the transport handler
                const result = transportHandler(method, url, headers, body);

                // Check if this is a sync result (Safari mode) or async Promise (JSPI mode)
                if (isSyncTransportResult(result)) {
                    console.log('[http] Using sync body path - $sync marker');
                    const response = result.value;
                    return new FutureIncomingResponse({
                        status: response.status,
                        headers: response.headers,
                        body: response.body
                    });
                }

                // Legacy sync pattern
                if ('syncValue' in result) {
                    console.log('[http] Using sync body path - legacy syncValue');
                    const response = (result as { syncValue: TransportResponse }).syncValue;
                    return new FutureIncomingResponse({
                        status: response.status,
                        headers: response.headers,
                        body: response.body
                    });
                }

                // Async path for JSPI mode - use lazy body stream with async/await
                console.log('[http] Using lazy body stream (JSPI mode)');
                const asyncResult = result as AsyncTransportResult;
                const bodyStream = createLazyBufferStream(
                    asyncResult.then((r: TransportResponse) => r.body)
                );

                return new FutureIncomingResponse({
                    status: 200,
                    headers: [] as [string, Uint8Array][],
                    bodyStream: bodyStream
                });
            }
        }

        // Handle OAuth popup requests from WASM
        // URL format: https://__oauth_popup__/start?auth_url=<encoded_auth_url>&server_id=<id>&server_url=<url>&code_verifier=<verifier>&state=<state>
        if (authority === '__oauth_popup__') {
            console.log('[http] OAuth popup request:', path);

            const oauthPromise = (async (): Promise<StreamingResponse> => {
                try {
                    // Parse parameters from path (query string)
                    const queryStart = path.indexOf('?');
                    const queryString = queryStart >= 0 ? path.slice(queryStart + 1) : '';
                    const params = new URLSearchParams(queryString);

                    const authUrl = params.get('auth_url');
                    const serverId = params.get('server_id') || '';
                    const serverUrl = params.get('server_url') || '';
                    const codeVerifier = params.get('code_verifier') || '';
                    const state = params.get('state') || '';

                    if (!authUrl) {
                        return {
                            status: 400,
                            headers: [['content-type', new TextEncoder().encode('application/json')]],
                            bodyStream: createInputStreamFromBytes(
                                new TextEncoder().encode(JSON.stringify({ error: 'Missing auth_url parameter' }))
                            )
                        };
                    }

                    // Use global OAuth handler registered by frontend
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const globalWindow = typeof window !== 'undefined' ? window as any : null;
                    const openOAuthPopup = globalWindow?.__mcpOAuthHandler;

                    if (!openOAuthPopup) {
                        console.error('[http] OAuth handler not registered. Register via window.__mcpOAuthHandler');
                        return {
                            status: 500,
                            headers: [['content-type', new TextEncoder().encode('application/json')]],
                            bodyStream: createInputStreamFromBytes(
                                new TextEncoder().encode(JSON.stringify({ error: 'OAuth handler not registered' }))
                            )
                        };
                    }

                    // Open popup and wait for authorization code
                    const code = await openOAuthPopup(authUrl, serverId, serverUrl, codeVerifier, state);

                    // Return the code to WASM
                    const responseBody = JSON.stringify({ code, state });
                    return {
                        status: 200,
                        headers: [['content-type', new TextEncoder().encode('application/json')]],
                        bodyStream: createInputStreamFromBytes(new TextEncoder().encode(responseBody))
                    };
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    console.error('[http] OAuth popup error:', errorMsg);
                    return {
                        status: 500,
                        headers: [['content-type', new TextEncoder().encode('application/json')]],
                        bodyStream: createInputStreamFromBytes(
                            new TextEncoder().encode(JSON.stringify({ error: errorMsg }))
                        )
                    };
                }
            })();

            return new FutureIncomingResponse(oauthPromise);
        }

        // For HTTPS requests, use async fetch with streaming body 
        // Pattern: Await fetch for status/headers, then stream body via JSPI
        if (schemeStr === 'https') {
            // Check if this URL should go through the CORS proxy
            let fetchUrl = url;
            const isProxied = shouldProxyViaCors(url);
            if (isProxied) {
                fetchUrl = getCorsProxyUrl(url);
                console.log('[http] Routing through CORS proxy:', method, url, '->', fetchUrl);
            } else {
                console.log('[http] Using async fetch (streaming body):', method, url);
            }

            // In sync mode (Safari/no JSPI), use streaming transport if available
            // This is required because WASM can't await promises in non-JSPI environments
            // Detect automatically: if JSPI is not supported OR explicit syncModeTransport is set
            const useSyncMode = !hasJSPI || syncModeTransport;
            if (useSyncMode) {
                console.log('[http] Sync mode detected for HTTPS:', method, url);

                // Check if streaming transport handler is available (registered by Worker)
                if (streamingTransportHandler) {
                    console.log('[http] Using streaming transport handler for HTTPS');

                    // Create streaming generator
                    const generator = streamingTransportHandler(method, fetchUrl, headers, body);

                    // Get first chunk to extract status/headers
                    const firstResult = generator.next();
                    if (firstResult.done) {
                        // Empty response
                        return new FutureIncomingResponse({
                            status: 200,
                            headers: [],
                            body: new Uint8Array(0)
                        });
                    }

                    const firstChunk = firstResult.value;
                    const status = firstChunk.status;
                    const responseHeaders = firstChunk.headers;

                    // Create streaming body that yields remaining chunks
                    const bodyStream = createSyncStreamingInputStreamFromChunks(
                        firstChunk.done ? null : firstChunk.chunk,
                        firstChunk.done,
                        generator
                    );

                    console.log('[http] Streaming response: status=', status);
                    return new FutureIncomingResponse({
                        status,
                        headers: responseHeaders,
                        bodyStream
                    });
                }

                // Fallback to XHR if no streaming handler
                console.log('[http] No streaming handler, falling back to sync XHR for HTTPS:', method, url);
                console.log('[http] Headers to set:', Object.keys(headers), headers);

                const xhr = new XMLHttpRequest();
                xhr.open(method, fetchUrl, false); // false = synchronous

                // Set headers (skip user-agent and host as they cause issues)
                for (const [name, value] of Object.entries(headers)) {
                    if (name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'host') {
                        try {
                            console.log(`[http] Setting header: ${name} = ${value.substring?.(0, 20) || value}...`);
                            xhr.setRequestHeader(name, value);
                        } catch (e) {
                            console.warn(`[http] Could not set header ${name}:`, e);
                        }
                    }
                }

                // Add proxy auth header for CORS proxy requests
                if (isProxied) {
                    xhr.setRequestHeader('X-Agent-Proxy', 'web-agent');
                }

                // Send request with body
                const requestBody = body ? new Blob([body as BlobPart]) : null;
                xhr.send(requestBody);

                // Build response
                const responseBody = xhr.responseText
                    ? new TextEncoder().encode(xhr.responseText)
                    : new Uint8Array(0);

                const responseHeaders: [string, Uint8Array][] = [];
                xhr.getAllResponseHeaders()
                    .trim()
                    .split(/[\r\n]+/)
                    .forEach((line) => {
                        const parts = line.split(': ');
                        const key = parts.shift();
                        const value = parts.join(': ');
                        if (key) {
                            responseHeaders.push([key.toLowerCase(), new TextEncoder().encode(value)]);
                        }
                    });

                console.log('[http] Sync XHR complete, status:', xhr.status, 'body len:', responseBody.length);
                if (xhr.status >= 400) {
                    console.log('[http] Error response body:', xhr.responseText);
                }
                return new FutureIncomingResponse({ status: xhr.status, headers: responseHeaders, body: responseBody });
            }

            // Build fetch options
            const filteredHeaders = Object.fromEntries(
                Object.entries(headers).filter(([name]) =>
                    name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'host'
                )
            );

            // Add proxy auth header for CORS proxy requests (required for Web Worker context)
            if (isProxied) {
                filteredHeaders['X-Agent-Proxy'] = 'web-agent';
            }

            const fetchOptions: RequestInit = {
                method,
                headers: filteredHeaders,
            };

            if (body && body.length > 0) {
                fetchOptions.body = new Blob([body as BlobPart]);
            }

            // Create an async promise that awaits the fetch for headers/status
            // then returns a streaming response with the actual metadata
            const fetchPromise = (async (): Promise<StreamingResponse> => {
                try {
                    const response = await fetch(fetchUrl, fetchOptions);

                    // Extract response headers
                    const responseHeaders: [string, Uint8Array][] = [];
                    response.headers.forEach((value, name) => {
                        responseHeaders.push([name.toLowerCase(), new TextEncoder().encode(value)]);
                    });

                    // Get body stream for lazy reading
                    const bodyStream = response.body
                        ? createStreamingInputStream(response.body.getReader())
                        : createInputStreamFromBytes(new Uint8Array(0));

                    return {
                        status: response.status,
                        headers: responseHeaders,
                        bodyStream
                    };
                } catch (error) {
                    // Handle network errors, CORS errors, etc. gracefully
                    // Return a synthetic 502 Bad Gateway response instead of crashing
                    const errorMessage = error instanceof Error ? error.message : 'Network error';
                    console.error('[http] Fetch failed:', method, url, '-', errorMessage);

                    const errorBody = JSON.stringify({
                        error: 'network_error',
                        message: errorMessage,
                        url: url
                    });

                    return {
                        status: 502,
                        headers: [
                            ['content-type', new TextEncoder().encode('application/json')],
                            ['x-error-source', new TextEncoder().encode('wasi-http-shim')]
                        ],
                        bodyStream: createInputStreamFromBytes(new TextEncoder().encode(errorBody))
                    };
                }
            })();

            // Return async FutureIncomingResponse that await the fetch
            // JSPI will suspend on Pollable.block() until fetch completes
            const result = new FutureIncomingResponse(fetchPromise);
            console.log('[http] Returning FutureIncomingResponse:',
                'constructor:', result.constructor.name,
                'instanceof:', result instanceof FutureIncomingResponse,
                'symbolCheck:', isFutureIncomingResponse(result));
            return result;
        }

        // Fallback to synchronous XMLHttpRequest for HTTP requests (localhost)
        // Treat localhost:3000 as a sentinel address for MCP - rewrite to relative path
        // XHR will resolve relative URLs against the current origin automatically
        let localUrl = url;
        if (authority === 'localhost:3000' || authority === '127.0.0.1:3000') {
            // Just use the path for relative resolution
            localUrl = path;
            console.log('[http] HTTP request (MCP sentinel):', method, url, '->', localUrl);
        } else {
            console.log('[http] HTTP request:', method, url);
        }

        // Check if streaming transport handler is available (registered by Worker)
        if (streamingTransportHandler) {
            console.log('[http] Using streaming transport handler for HTTP localhost');

            // Create streaming generator
            const generator = streamingTransportHandler(method, localUrl, headers, body);

            // Get first chunk to extract status/headers
            const firstResult = generator.next();
            if (firstResult.done) {
                // Empty response
                return new FutureIncomingResponse({
                    status: 200,
                    headers: [],
                    body: new Uint8Array(0)
                });
            }

            const firstChunk = firstResult.value;
            const status = firstChunk.status;
            const responseHeaders = firstChunk.headers;

            // Create streaming body that yields remaining chunks
            const bodyStream = createSyncStreamingInputStreamFromChunks(
                firstChunk.done ? null : firstChunk.chunk,
                firstChunk.done,
                generator
            );

            console.log('[http] Streaming HTTP response: status=', status);
            return new FutureIncomingResponse({
                status,
                headers: responseHeaders,
                bodyStream
            });
        }

        // In JSPI mode, use async fetch for localhost HTTP (same as HTTPS path)
        // This avoids blocking the main thread with sync XHR
        if (hasJSPI) {
            console.log('[http] Using async fetch for HTTP localhost (JSPI mode):', method, localUrl);

            // Build fetch options
            const filteredHeaders = Object.fromEntries(
                Object.entries(headers).filter(([name]) =>
                    name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'host'
                )
            );

            const fetchOptions: RequestInit = {
                method,
                headers: filteredHeaders,
            };

            if (body && body.length > 0) {
                fetchOptions.body = new Blob([body as BlobPart]);
            }

            // Create an async promise that awaits the fetch for headers/status
            const fetchPromise = (async (): Promise<StreamingResponse> => {
                try {
                    const response = await fetch(localUrl, fetchOptions);

                    // Extract response headers
                    const responseHeaders: [string, Uint8Array][] = [];
                    response.headers.forEach((value, name) => {
                        responseHeaders.push([name.toLowerCase(), new TextEncoder().encode(value)]);
                    });

                    // Get body stream for lazy reading
                    const bodyStream = response.body
                        ? createStreamingInputStream(response.body.getReader())
                        : createInputStreamFromBytes(new Uint8Array(0));

                    return {
                        status: response.status,
                        headers: responseHeaders,
                        bodyStream
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Network error';
                    console.error('[http] Fetch failed:', method, localUrl, '-', errorMessage);

                    const errorBody = JSON.stringify({
                        error: 'network_error',
                        message: errorMessage,
                        url: localUrl
                    });

                    return {
                        status: 502,
                        headers: [
                            ['content-type', new TextEncoder().encode('application/json')],
                            ['x-error-source', new TextEncoder().encode('wasi-http-shim')]
                        ],
                        bodyStream: createInputStreamFromBytes(new TextEncoder().encode(errorBody))
                    };
                }
            })();

            return new FutureIncomingResponse(fetchPromise);
        }

        // Fallback to sync XHR for non-JSPI environments (Safari)
        console.log('[http] No streaming handler, falling back to sync XHR');
        const xhr = new XMLHttpRequest();
        xhr.open(method, localUrl, false); // false = synchronous

        // Set headers (skip user-agent and host as they cause issues)
        for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'host') {
                try {
                    xhr.setRequestHeader(name, value);
                } catch (e) {
                    console.warn(`[http] Could not set header ${name}:`, e);
                }
            }
        }

        // Use Blob for XHR body
        const requestBody = body ? new Blob([body as BlobPart]) : null;

        // Send request with body
        xhr.send(requestBody);

        // Build response
        const responseBody = xhr.responseText
            ? new TextEncoder().encode(xhr.responseText)
            : new Uint8Array(0);

        const responseHeaders: [string, Uint8Array][] = [];
        xhr.getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/)
            .forEach((line) => {
                const parts = line.split(': ');
                const key = parts.shift();
                const value = parts.join(': ');
                if (key) {
                    responseHeaders.push([key.toLowerCase(), new TextEncoder().encode(value)]);
                }
            });

        // Create a pre-resolved FutureIncomingResponse
        const resolvedResponse = { status: xhr.status, headers: responseHeaders, body: responseBody };
        return new FutureIncomingResponse(resolvedResponse);
    }
};

export function createIncomingRequest(
    method: string,
    pathWithQuery: string,
    headers: Fields,
    body: string
): IncomingRequest {
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(body);
    const incomingBody = new IncomingBody(bodyBytes);

    return new IncomingRequest(
        method,
        pathWithQuery,
        'https',
        'localhost',
        headers,
        incomingBody
    );
}


