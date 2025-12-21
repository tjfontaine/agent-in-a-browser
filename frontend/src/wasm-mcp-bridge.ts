/**
 * WASM MCP Bridge
 * 
 * Bridges between the JSON-RPC MCP protocol and the WASM component's
 * wasi:http/incoming-handler interface.
 */

import { incomingHandler } from './wasm/mcp-server/ts-runtime-mcp.js';
import {
    createJsonRpcRequest,
    ResponseOutparam,
    OutgoingResponse
} from './wasm/wasi-http-impl.js';
import { JsonRpcRequest, JsonRpcResponse } from './mcp-client';
import { initFilesystem } from './wasm/opfs-filesystem-impl';

// Track if OPFS has been initialized
let opfsInitialized = false;

/**
 * Ensure OPFS filesystem is initialized before WASM calls
 */
async function ensureOpfsInit(): Promise<void> {
    if (opfsInitialized) return;

    console.log('[WASM Bridge] Initializing OPFS filesystem...');
    await initFilesystem();
    opfsInitialized = true;
    console.log('[WASM Bridge] OPFS filesystem initialized');
}

/**
 * Call the WASM MCP server with a JSON-RPC request
 * 
 * This function:
 * 1. Serializes the JSON-RPC request to JSON
 * 2. Creates an IncomingRequest with the JSON body
 * 3. Creates a ResponseOutparam to capture the response
 * 4. Invokes the WASM handler
 * 5. Parses and returns the JSON-RPC response
 */
export async function callWasmMcpServer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    // Ensure OPFS is initialized before any WASM calls
    await ensureOpfsInit();

    // 1. Serialize the request to JSON
    const requestBody = JSON.stringify(request);

    // 2. Create the IncomingRequest with the JSON-RPC payload
    const incomingRequest = createJsonRpcRequest(requestBody);

    // 3. Create a ResponseOutparam with a Promise to capture the response
    let capturedResponse: OutgoingResponse | null = null;
    let responseError: any = null;

    const responseOutparam = new ResponseOutparam((result) => {
        if (result.tag === 'ok') {
            capturedResponse = result.val;
        } else {
            responseError = result.val;
        }
    });

    // 4. Invoke the WASM handler
    try {
        // The handler is synchronous in the current implementation
        incomingHandler.handle(incomingRequest, responseOutparam);
    } catch (error) {
        console.error('[WASM Bridge] Handler error:', error);
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
            }
        };
    }

    // 5. Check for errors
    if (responseError) {
        console.error('[WASM Bridge] Response error:', responseError);
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: `Handler error: ${responseError}`
            }
        };
    }

    // 6. Get the response from the outparam
    capturedResponse = responseOutparam.getResponse();

    if (!capturedResponse) {
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: 'No response received from WASM handler'
            }
        };
    }

    // 7. Read the response body
    const responseBody = capturedResponse.getBodyAsString();

    if (!responseBody) {
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: 'Empty response body from WASM handler'
            }
        };
    }

    // 8. Parse the JSON-RPC response
    try {
        const jsonResponse = JSON.parse(responseBody);
        return jsonResponse as JsonRpcResponse;
    } catch (parseError) {
        console.error('[WASM Bridge] Failed to parse response:', responseBody);
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32700,
                message: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            }
        };
    }
}

/**
 * Initialize the WASM MCP bridge
 * This is called once to ensure the WASM module is loaded
 */
export async function initWasmBridge(): Promise<void> {
    await ensureOpfsInit();
    console.log('[WASM Bridge] Initialized');
}

