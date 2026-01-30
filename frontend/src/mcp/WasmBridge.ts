/**
 * WASM MCP Bridge
 * 
 * Bridges between the JSON-RPC MCP protocol and the WASM component's
 * wasi:http/incoming-handler interface.
 * 
 * This bridge connects standard Web Fetch API objects (Request, Response, ReadableStream)
 * directly to the WASI HTTP shim, minimizing data copying and buffering.
 * 
 * Supports dual async modes:
 * - JSPI mode (Chrome): Uses WebAssembly.Suspending for true async
 * - Sync mode (Safari/Firefox): Eager module loading, synchronous execution
 */

import { getIncomingHandler, hasJSPI } from '../wasm/lazy-loading/async-mode.js';
import {
    createIncomingRequest,
    Fields,
    ResponseOutparam,
    IncomingRequest,
} from '@tjfontaine/wasi-shims/wasi-http-impl.js';
import { prepareFileForSync } from '@tjfontaine/wasi-shims/opfs-filesystem-impl.js';

/**
 * Debug log helper that posts messages to main thread for visibility in test UI
 */
function workerLog(msg: string, data?: unknown): void {
    console.log('[WasmBridge]', msg, data || '');
    // Post to main thread so logs appear in error-context UI
    try {
        self.postMessage({ type: 'worker-log', msg: `[WasmBridge] ${msg}`, data, time: Date.now() });
    } catch {
        // Ignore if postMessage fails
    }
}

// Type for WASM response objects
interface WasmResponse {
    statusCode(): number;
    headers(): { entries(): [string, Uint8Array][] };
    _bodyChunks?: Uint8Array[];
}


// Re-export types for consumers
export type { JsonRpcRequest, JsonRpcResponse } from './Client';

/**
 * Intercept and prepare file paths for file operations.
 * Must be called before WASM operations that access files.
 * Only needed in JSPI mode - sync mode handles files via the helper worker.
 */
async function prepareFileOperation(body: string): Promise<void> {
    // In sync mode (non-JSPI), the helper worker handles file access directly
    // No need to prepare sync handles manually
    if (!hasJSPI) {
        return;
    }

    try {
        const parsed = JSON.parse(body);
        // Check if this is a file tool call that needs a sync handle
        if (parsed.method === 'tools/call') {
            const toolName = parsed.params?.name;
            const args = parsed.params?.arguments;

            // Get the path parameter based on tool name
            let path: string | undefined;
            switch (toolName) {
                case 'write_file':
                case 'read_file':
                    path = args?.path;
                    break;
                case 'grep':
                    // grep operates on existing files, handle path for the search directory
                    path = args?.path;
                    break;
                // list_directory doesn't need sync handles - it reads the directory tree
            }

            if (path) {
                console.log('[WasmBridge] Preparing sync handle for', toolName + ':', path);
                await prepareFileForSync(path);
            }
        }
    } catch {
        // Not JSON or not a file tool call, ignore
    }
}

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
    let incomingRequest: IncomingRequest;
    let bodyText = "";
    if (req.body) {
        bodyText = await req.text();
        console.log('[WasmBridge] Request body:', bodyText.substring(0, 200));

        // Intercept file operations to prepare sync handles
        await prepareFileOperation(bodyText);

        incomingRequest = createIncomingRequest(req.method, req.url, fields, bodyText);
    } else {
        incomingRequest = createIncomingRequest(req.method, req.url, fields, "");
    }
    console.log('[WasmBridge] IncomingRequest created');

    // 3. Create response outparam and call handler
    let wasmResponse: WasmResponse | null = null;

    const responseOutparam = new ResponseOutparam((result) => {
        console.log('[WasmBridge] >>> ResponseOutparam callback INVOKED at:', Date.now(), 'result tag:', result?.tag);
        if (result.tag === 'err') {
            console.error('[WasmBridge] !!! ResponseOutparam error:', result.val);
            throw result.val;
        }
        wasmResponse = result.val;
        console.log('[WasmBridge] >>> ResponseOutparam: wasmResponse set, status:', wasmResponse?.statusCode?.());
    });

    workerLog('>>> Step 1a: Getting incoming handler...');
    const handleStartTime = Date.now();
    try {
        workerLog('>>> Step 1a: Getting incoming handler...');
        const incomingHandler = getIncomingHandler();
        workerLog(`>>> Step 1b: Got incomingHandler, hasJSPI: ${hasJSPI}, handler type: ${typeof incomingHandler}`);
        workerLog('>>> Step 2: Calling handle() method...');
        // Cast to any because our IncomingRequest is compatible at runtime with the WASM-generated type
        // In JSPI mode, handle() returns a Promise; in Sync mode it returns void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = incomingHandler.handle(incomingRequest as any, responseOutparam);
        workerLog(`>>> Step 3: handle() returned, result type: ${typeof result}, isPromise: ${result instanceof Promise}, elapsed: ${Date.now() - handleStartTime}ms`);
        if (hasJSPI && result instanceof Promise) {
            workerLog('>>> Step 4: Awaiting JSPI promise...');
            await result;
            workerLog(`>>> Step 5: JSPI promise resolved, elapsed: ${Date.now() - handleStartTime}ms`);
        }
    } catch (error) {
        workerLog(`!!! Error in handle: ${error}, elapsed: ${Date.now() - handleStartTime}ms`);
        throw error;
    }
    workerLog(`>>> Step 6: incomingHandler.handle completed, elapsed: ${Date.now() - handleStartTime}ms`);

    // 4. Get response from WASM
    if (!wasmResponse) {
        wasmResponse = responseOutparam.getResponse();
    }

    if (!wasmResponse) {
        throw new Error('No response from WASM handler');
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
    const stream = new Blob(bodyChunks as any).stream();

    return {
        status: wasmResponse.statusCode(),
        headers: respHeaders,
        body: stream
    };
}


/**
 * Initialize the WASM MCP bridge
 */
export async function initWasmBridge(): Promise<void> {
    console.log('[WASM Bridge] Initialized');
}
