/**
 * WASM MCP Bridge
 * 
 * Bridges between the JSON-RPC MCP protocol and the WASM component's
 * wasi:http/incoming-handler interface.
 * 
 * Note: OPFS initialization is handled by sandbox-worker before any MCP calls.
 */

import { incomingHandler } from './wasm/mcp-server/ts-runtime-mcp.js';
import {
    createJsonRpcRequest,
    ResponseOutparam,
    OutgoingResponse
} from './wasm/wasi-http-impl.js';
import { JsonRpcRequest, JsonRpcResponse } from './mcp-client';

// Re-export types for consumers
export type { JsonRpcRequest, JsonRpcResponse } from './mcp-client';

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
 * Note: OPFS is initialized by sandbox-worker, so this is now a no-op
 */
export async function initWasmBridge(): Promise<void> {
    console.log('[WASM Bridge] Initialized');
}

/**
 * SSE event types for streaming responses
 */
export interface SSEEvent {
    event?: string;  // Event type (e.g., 'message', 'progress', 'error')
    data: string;    // Event data (JSON or text)
    id?: string;     // Optional event ID
}

/**
 * Streaming callback type - receives SSE events as they arrive
 */
export type StreamingCallback = (event: SSEEvent) => void;

/**
 * Call the WASM MCP server with streaming response support
 * 
 * This function enables real-time streaming of responses, which is useful for:
 * - Long-running tool executions with progress updates
 * - SSE (Server-Sent Events) compatibility
 * - Live output from TypeScript execution
 * 
 * @param request The JSON-RPC request
 * @param onEvent Callback for each SSE event as it arrives
 * @returns The final JSON-RPC response (after all streaming events)
 */
export async function callWasmMcpServerStreaming(
    request: JsonRpcRequest,
    onEvent: StreamingCallback
): Promise<JsonRpcResponse> {
    const requestBody = JSON.stringify(request);

    // Create SSE-enabled incoming request
    const incomingRequest = createSseRequest(requestBody);

    // Chunk accumulator for SSE parsing
    let partialData = '';

    // Create response outparam with streaming callback
    let capturedResponse: OutgoingResponse | null = null;
    let responseError: any = null;

    const responseOutparam = new ResponseOutparam((result) => {
        if (result.tag === 'ok') {
            capturedResponse = result.val;
        } else {
            responseError = result.val;
        }
    });

    // Note: With the current sync implementation, streaming events are
    // buffered and emitted after the handler returns. True incremental
    // streaming would require async handler support.
    try {
        incomingHandler.handle(incomingRequest, responseOutparam);
    } catch (error) {
        console.error('[WASM Bridge] Streaming handler error:', error);
        onEvent({ event: 'error', data: JSON.stringify({ error: String(error) }) });
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
            }
        };
    }

    if (responseError) {
        onEvent({ event: 'error', data: JSON.stringify(responseError) });
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: `Handler error: ${responseError}`
            }
        };
    }

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

    // Parse response - check if it's SSE format or plain JSON
    const responseBody = capturedResponse.getBodyAsString();

    if (!responseBody) {
        return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
                code: -32603,
                message: 'Empty response body'
            }
        };
    }

    // Check if response contains SSE events (event: / data: format)
    if (responseBody.includes('event:') || responseBody.includes('data:')) {
        // Parse SSE events
        const events = parseSSEEvents(responseBody);
        for (const event of events) {
            onEvent(event);
        }

        // Return the last event's data as the response
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
            try {
                return JSON.parse(lastEvent.data) as JsonRpcResponse;
            } catch {
                // Last event wasn't valid JSON, return as text result
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: { text: lastEvent.data }
                };
            }
        }
    }

    // Plain JSON response
    try {
        const jsonResponse = JSON.parse(responseBody);
        onEvent({ event: 'message', data: responseBody });
        return jsonResponse as JsonRpcResponse;
    } catch (parseError) {
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
 * Create an IncomingRequest that indicates SSE support via Accept header
 */
function createSseRequest(body: string): ReturnType<typeof createJsonRpcRequest> {
    // For now, use the standard JSON-RPC request creator
    // The handler checks the Accept header to determine SSE support
    // TODO: Add Accept: text/event-stream header support
    return createJsonRpcRequest(body);
}

/**
 * Parse SSE-formatted text into events
 */
function parseSSEEvents(text: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    const lines = text.split('\n');

    let currentEvent: Partial<SSEEvent> = {};

    for (const line of lines) {
        if (line.startsWith('event:')) {
            currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            currentEvent.data = line.slice(5).trim();
        } else if (line.startsWith('id:')) {
            currentEvent.id = line.slice(3).trim();
        } else if (line === '' && currentEvent.data) {
            // Empty line = end of event
            events.push(currentEvent as SSEEvent);
            currentEvent = {};
        }
    }

    // Handle trailing event without final newline
    if (currentEvent.data) {
        events.push(currentEvent as SSEEvent);
    }

    return events;
}

