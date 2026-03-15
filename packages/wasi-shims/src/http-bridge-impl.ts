/**
 * HTTP Bridge Implementation for Go WASM modules.
 *
 * This shim implements the host-side of the `http_bridge` WASM imports
 * defined in stripe-cli-wasm/wasm-bridge/transport.go. It receives
 * HTTP requests from Go code running in WASM and executes them using
 * the browser's fetch() API.
 *
 * The Go side uses `//go:wasmimport http_bridge request` etc. to call
 * these functions. JCO maps the WASM imports to this module via the
 * --map flag in transpile.mjs.
 */

import { hasJSPI } from './execution-mode';

// ============================================================================
// Response Handle Management
// ============================================================================

interface PendingResponse {
    status: number;
    headers: string; // JSON-encoded
    body: Uint8Array;
    bodyOffset: number;
}

let nextHandle = 1;
const responses = new Map<number, PendingResponse>();

// ============================================================================
// Exported Host Functions
// ============================================================================

/**
 * Execute an HTTP request and return a handle to the response.
 *
 * Called from Go via: //go:wasmimport http_bridge request
 *
 * In JSPI mode, this function is async (the WASM stack suspends).
 * In sync mode, this blocks via SharedArrayBuffer/Atomics.wait
 * (handled by the sync bridge infrastructure).
 */
export function request(
    method: string,
    url: string,
    headers: string,
    body: Uint8Array,
): number | Promise<number> {
    if (hasJSPI) {
        return requestAsync(method, url, headers, body);
    }
    return requestSync(method, url, headers, body);
}

async function requestAsync(
    method: string,
    url: string,
    headers: string,
    body: Uint8Array,
): Promise<number> {
    const parsedHeaders: Record<string, string> = headers ? JSON.parse(headers) : {};

    const fetchInit: RequestInit = {
        method,
        headers: parsedHeaders,
    };

    if (body.length > 0) {
        fetchInit.body = body as unknown as BodyInit;
    }

    try {
        const response = await fetch(url, fetchInit);
        const responseBody = new Uint8Array(await response.arrayBuffer());

        // Collect response headers as JSON
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            respHeaders[key] = value;
        });

        const handle = nextHandle++;
        responses.set(handle, {
            status: response.status,
            headers: JSON.stringify(respHeaders),
            body: responseBody,
            bodyOffset: 0,
        });

        return handle;
    } catch (err) {
        console.error('[http-bridge] fetch error:', err);
        // Return a synthetic 502 response
        const handle = nextHandle++;
        responses.set(handle, {
            status: 502,
            headers: '{}',
            body: new TextEncoder().encode(`Fetch error: ${err}`),
            bodyOffset: 0,
        });
        return handle;
    }
}

function requestSync(
    method: string,
    url: string,
    headers: string,
    body: Uint8Array,
): number {
    // In sync mode, we use XMLHttpRequest which can be synchronous
    // eslint-disable-next-line no-restricted-globals
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false); // synchronous
    xhr.responseType = 'arraybuffer';

    const parsedHeaders: Record<string, string> = headers ? JSON.parse(headers) : {};
    for (const [key, value] of Object.entries(parsedHeaders)) {
        xhr.setRequestHeader(key, value);
    }

    try {
        xhr.send(body.length > 0 ? (body as unknown as XMLHttpRequestBodyInit) : null);
    } catch (err) {
        console.error('[http-bridge] XHR error:', err);
        const handle = nextHandle++;
        responses.set(handle, {
            status: 502,
            headers: '{}',
            body: new TextEncoder().encode(`XHR error: ${err}`),
            bodyOffset: 0,
        });
        return handle;
    }

    // Collect response headers
    const respHeaders: Record<string, string> = {};
    const rawHeaders = xhr.getAllResponseHeaders().trim();
    if (rawHeaders) {
        for (const line of rawHeaders.split('\r\n')) {
            const idx = line.indexOf(': ');
            if (idx > 0) {
                respHeaders[line.substring(0, idx).toLowerCase()] = line.substring(idx + 2);
            }
        }
    }

    const handle = nextHandle++;
    responses.set(handle, {
        status: xhr.status,
        headers: JSON.stringify(respHeaders),
        body: new Uint8Array(xhr.response as ArrayBuffer),
        bodyOffset: 0,
    });
    return handle;
}

/**
 * Get the HTTP status code for a response.
 *
 * Called from Go via: //go:wasmimport http_bridge response_status
 */
export function responseStatus(handle: number): number {
    const resp = responses.get(handle);
    if (!resp) {
        console.error('[http-bridge] responseStatus: invalid handle', handle);
        return 0;
    }
    return resp.status;
}

/**
 * Get response headers as JSON, written into the provided buffer.
 * Returns the number of bytes written.
 *
 * Called from Go via: //go:wasmimport http_bridge response_headers
 *
 * Note: The Go side passes a pointer into its linear memory. In the JCO
 * transpiled environment, we receive a buffer view that we write into.
 */
export function responseHeaders(handle: number): string {
    const resp = responses.get(handle);
    if (!resp) {
        console.error('[http-bridge] responseHeaders: invalid handle', handle);
        return '{}';
    }
    return resp.headers;
}

/**
 * Read response body data. Returns bytes read (0 = EOF).
 *
 * Called from Go via: //go:wasmimport http_bridge response_body_read
 */
export function responseBodyRead(handle: number, maxBytes: number): Uint8Array {
    const resp = responses.get(handle);
    if (!resp) {
        console.error('[http-bridge] responseBodyRead: invalid handle', handle);
        return new Uint8Array(0);
    }

    const remaining = resp.body.length - resp.bodyOffset;
    if (remaining <= 0) {
        return new Uint8Array(0);
    }

    const readLen = Math.min(remaining, maxBytes);
    const chunk = resp.body.slice(resp.bodyOffset, resp.bodyOffset + readLen);
    resp.bodyOffset += readLen;

    return chunk;
}

/**
 * Close a response handle and free resources.
 *
 * Called from Go via: //go:wasmimport http_bridge response_close
 */
export function responseClose(handle: number): void {
    responses.delete(handle);
}
