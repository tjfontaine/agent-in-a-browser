// Import stream classes from shared module to avoid duplication
import { InputStream, OutputStream, ReadyPollable } from './streams';

// Type for WASM Result-like return values
type WasmResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

// ============ Transport Interceptor ============
// Allows routing requests to different backends (e.g., sandbox worker for local MCP)

type TransportHandler = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null
) => Promise<{ status: number; headers: [string, Uint8Array][]; body: Uint8Array }>;

let transportHandler: TransportHandler | null = null;

/**
 * Set a custom transport handler for intercepting HTTP requests.
 * The handler receives (method, url, headers, body) and returns a response.
 * This allows routing requests to web workers instead of making actual HTTP calls.
 */
export function setTransportHandler(handler: TransportHandler | null): void {
    transportHandler = handler;
}

/**
 * Check if a URL should be intercepted by the transport handler.
 * Returns true for localhost MCP endpoints.
 */
function shouldIntercept(url: string): boolean {
    // Intercept localhost MCP calls
    return url.includes('localhost') && url.includes('/mcp');
}

// ============ CORS Proxy Configuration ============
// Domains that should be routed through the CORS proxy
const CORS_PROXY_DOMAINS = [
    'mcp.stripe.com',
    'api.githubcopilot.com',
    'github.com',
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

// Get BasePollable from preview2-shim for proper instanceof checks
import { poll } from '@bytecodealliance/preview2-shim/io';
// @ts-expect-error - Pollable is exported at runtime
const { Pollable: BasePollable } = poll as { Pollable: new () => { ready(): boolean; block(): void } };

/**
 * AsyncPollable - a pollable that waits on a Promise
 * Must extend BasePollable for JCO instanceof checks to pass.
 */
class AsyncPollable extends BasePollable {
    private _ready: boolean = false;
    private _promise: Promise<void>;

    constructor(promise: Promise<void>) {
        super();
        this._promise = promise;
        promise.then(() => {
            this._ready = true;
        }).catch(() => {
            this._ready = true; // Ready on error too
        });
    }

    ready(): boolean {
        return this._ready;
    }

    async block(): Promise<void> {
        await this._promise;
    }
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
    private _result: WasmResult<IncomingResponse> | null = null;
    private _promise: Promise<void> | null = null;
    private _pollable: AsyncPollable | ReadyPollable;

    constructor(resolvedDataOrPromise: ResolvedResponse | StreamingResponse | Promise<ResolvedResponse | StreamingResponse>) {
        if (resolvedDataOrPromise instanceof Promise) {
            // Async case - resolve later
            this._promise = resolvedDataOrPromise.then((resolvedData) => {
                this._setResult(resolvedData);
            }).catch((err) => {
                this._result = { tag: 'err', val: String(err) };
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
        return this._pollable;
    }

    /**
     * Get the response. Returns:
     * - undefined: not ready
     * - { tag: 'ok', val: { tag: 'ok', val: IncomingResponse } }: success
     * - { tag: 'ok', val: { tag: 'err', val: ErrorCode } }: HTTP error
     */
    get(): { tag: 'ok', val: WasmResult<IncomingResponse> } | undefined {
        if (this._result === null) {
            return undefined; // Not ready
        }
        return { tag: 'ok', val: this._result };
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
        // Handle WASI scheme tags - may be 'HTTPS', 'https', or { tag: 'https' }
        let schemeStr = 'http';
        if (scheme) {
            const tag = (typeof scheme === 'string' ? scheme : scheme.tag) || '';
            if (tag.toLowerCase() === 'https') {
                schemeStr = 'https';
            } else if (tag.toLowerCase() === 'http') {
                schemeStr = 'http';
            }
        }
        const authority = request.authority() || '';
        const path = request.pathWithQuery() || '/';
        const url = `${schemeStr}://${authority}${path}`;

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

        // Check if we should route through transport handler
        // Use lazy buffer stream pattern - JSPI suspension in blockingRead, not Pollable.block
        if (transportHandler && shouldIntercept(url)) {
            console.log('[http] Routing via transport handler:', method, url);

            // Start the request and create a lazy body stream
            const responsePromise = transportHandler(method, url, headers, body);
            const bodyStream = createLazyBufferStream(
                responsePromise.then(r => r.body)
            );

            // Return sync FutureIncomingResponse with lazy body
            // Status/headers will be determined when body is first read
            return new FutureIncomingResponse({
                status: 200, // Default, actual status doesn't matter for MCP JSON-RPC
                headers: [] as [string, Uint8Array][],
                bodyStream: bodyStream
            });
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
            if (shouldProxyViaCors(url)) {
                fetchUrl = getCorsProxyUrl(url);
                console.log('[http] Routing through CORS proxy:', method, url, '->', fetchUrl);
            } else {
                console.log('[http] Using async fetch (streaming body):', method, url);
            }

            // Build fetch options
            const fetchOptions: RequestInit = {
                method,
                headers: Object.fromEntries(
                    Object.entries(headers).filter(([name]) =>
                        name.toLowerCase() !== 'user-agent' && name.toLowerCase() !== 'host'
                    )
                ),
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
            return new FutureIncomingResponse(fetchPromise);
        }

        // Fallback to synchronous XMLHttpRequest for HTTP requests (localhost)
        console.log('[http] Using sync XHR:', method, url);
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, false); // false = synchronous

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


