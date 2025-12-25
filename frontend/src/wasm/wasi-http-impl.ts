// Import stream classes from shared module to avoid duplication
import { InputStream, OutputStream, ReadyPollable } from './streams';

// Type for WASM Result-like return values
type WasmResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

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

/**
 * FutureIncomingResponse - represents a pending HTTP response
 * 
 * IMPORTANT: Since we use synchronous XHR, the result is available immediately.
 * We store it directly instead of using Promise.then() which is async.
 */
export class FutureIncomingResponse {
    private _result: WasmResult<IncomingResponse> | null = null;

    constructor(resolvedData: { status: number; headers: [string, Uint8Array][]; body: Uint8Array }) {
        // Store result synchronously since XHR is synchronous
        const headers = new Fields();
        for (const [name, value] of resolvedData.headers) {
            const existing = headers.get(name);
            headers.set(name, [...existing, value]);
        }
        const body = new IncomingBody(resolvedData.body);
        this._result = { tag: 'ok', val: new IncomingResponse(resolvedData.status, headers, body) };
    }

    subscribe(): unknown {
        // Return a pollable that's immediately ready
        return new ReadyPollable();
    }

    /**
     * Get the response. Returns:
     * - undefined: not ready (never happens with sync XHR)
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
        this._body = new OutgoingBody(null);
        return this._body;
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
 * The outgoing handler - makes actual HTTP requests using synchronous XMLHttpRequest
 * Note: sync XHR is deprecated but necessary for WASM components that expect sync I/O
 * 
 * Returns FutureIncomingResponse directly (jco wraps in Result automatically)
 * Throws on error (jco catches and converts to Result.err)
 */
export const outgoingHandler = {
    handle(request: OutgoingRequest, _options: RequestOptions | null): FutureIncomingResponse {
        // Build the URL
        const scheme = request.scheme();
        const schemeStr = scheme?.tag === 'https' ? 'https' : (scheme?.tag === 'http' ? 'http' : 'https');
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

        // Use synchronous XMLHttpRequest
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

        // Send request
        xhr.send(null);

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


