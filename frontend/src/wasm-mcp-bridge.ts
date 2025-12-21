/**
 * WASM MCP Bridge
 * 
 * Bridges between the JSON-RPC MCP protocol and the WASM component's
 * wasi:http/incoming-handler interface.
 * 
 * This bridge connects standard Web Fetch API objects (Request, Response, ReadableStream)
 * directly to the WASI HTTP shim, minimizing data copying and buffering.
 */

import { incomingHandler } from './wasm/mcp-server/ts-runtime-mcp.js';
import {
    createIncomingRequest,
    Fields,
    ResponseOutparam,
    OutgoingResponse
} from './wasm/wasi-http-impl.js';

// Re-export types for consumers
export type { JsonRpcRequest, JsonRpcResponse } from './mcp-client';

/**
 * Call the WASM MCP server with a Request object
 * 
 * This function:
 * 1. Maps the Web Request to a WASI IncomingRequest
 * 2. Streams the request body to the WASM component
 * 3. Pipes the WASM component's response body to a ReadableStream
 * 4. Returns a standard-like Response structure (status, headers, body stream)
 */
/**
 * Call the WASM MCP server with a Request object
 * 
 * This function:
 * 1. Maps the Web Request to a WASI IncomingRequest
 * 2. Calls the WASM incoming handler
 * 3. Captures the response that WASM produces
 * 4. Returns a standard-like Response structure (status, headers, body stream)
 */
export async function callWasmMcpServerFetch(req: Request): Promise<{ status: number, headers: Headers, body: ReadableStream }> {
    console.log('[WasmBridge] callWasmMcpServerFetch called:', req.method, req.url);

    // 1. Convert headers
    const fields = new Fields();
    req.headers.forEach((val, key) => fields.set(key, [new TextEncoder().encode(val)]));
    console.log('[WasmBridge] Headers converted');

    // 2. Prepare request
    let incomingRequest: any;
    if (req.body) {
        const text = await req.text();
        console.log('[WasmBridge] Request body:', text.substring(0, 200));
        incomingRequest = createIncomingRequest(req.method, req.url, fields, text);
    } else {
        incomingRequest = createIncomingRequest(req.method, req.url, fields, "");
    }
    console.log('[WasmBridge] IncomingRequest created');

    // 3. Create response outparam and call handler
    return new Promise((resolve, reject) => {
        let wasmResponse: any = null;

        const responseOutparam = new ResponseOutparam((result) => {
            console.log('[WasmBridge] ResponseOutparam callback:', result);
            if (result.tag === 'err') {
                reject(result.val);
                return;
            }
            wasmResponse = result.val;
        });

        console.log('[WasmBridge] Calling incomingHandler.handle...');
        try {
            incomingHandler.handle(incomingRequest, responseOutparam);
        } catch (error) {
            console.error('[WasmBridge] Error in handle:', error);
            reject(error);
            return;
        }
        console.log('[WasmBridge] incomingHandler.handle returned');

        // 4. Get response from WASM
        if (!wasmResponse) {
            wasmResponse = responseOutparam.getResponse();
        }

        if (!wasmResponse) {
            reject(new Error('No response from WASM handler'));
            return;
        }

        console.log('[WasmBridge] Got WASM response, status:', wasmResponse.statusCode());

        // 5. Convert headers
        const respHeaders = new Headers();
        wasmResponse.headers().entries().forEach(([k, v]: [string, Uint8Array]) => {
            respHeaders.append(String(k), new TextDecoder().decode(v));
        });

        // 6. Get body content from WASM response's collected chunks
        const bodyChunks = wasmResponse._bodyChunks || [];
        console.log('[WasmBridge] Body chunks:', bodyChunks.length);

        // Create a ReadableStream from the collected body
        const stream = new ReadableStream({
            start(controller) {
                for (const chunk of bodyChunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            }
        });

        resolve({
            status: wasmResponse.statusCode(),
            headers: respHeaders,
            body: stream
        });
    });
}


/**
 * Initialize the WASM MCP bridge
 */
export async function initWasmBridge(): Promise<void> {
    console.log('[WASM Bridge] Initialized');
}
