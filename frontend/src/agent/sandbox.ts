/**
 * Sandbox Worker Management
 * 
 * Manages the sandbox worker for MCP tool execution.
 */

import type { SandboxMessage, ToolCallResult } from '../types';

// ============ Worker Instance ============

const sandbox = new Worker(new URL('../sandbox-worker.ts', import.meta.url), { type: 'module' });

// Pending tool call resolvers
const pendingToolCalls = new Map<string, (result: ToolCallResult) => void>();

// ============ State ============

let onMcpInitialized: ((serverInfo: { name: string; version: string }, tools: Array<{ name: string; description?: string }>) => void) | null = null;
let onStatus: ((message: string) => void) | null = null;
let onReady: (() => void) | null = null;
let onError: ((message: string) => void) | null = null;
let onConsole: ((message: string) => void) | null = null;

// ============ Message Handler ============

sandbox.onmessage = (event: MessageEvent<SandboxMessage>) => {
    const { type, message, id } = event.data;

    switch (type) {
        case 'status':
            onStatus?.(message || '');
            break;

        case 'ready':
            onReady?.();
            sandbox.postMessage({ type: 'get_tools' });
            break;

        case 'mcp-initialized':
            onMcpInitialized?.(
                event.data.serverInfo!,
                event.data.tools || []
            );
            break;

        case 'tools':
            // Tools now managed by agent SDK via MCP bridge
            console.log('Loaded tools:', event.data.tools?.map((t) => t.name));
            break;

        case 'tool_result':
            const resolver = pendingToolCalls.get(id || '');
            if (resolver) {
                resolver(event.data.result as ToolCallResult);
                pendingToolCalls.delete(id || '');
            }
            break;

        case 'console':
            onConsole?.(message || '');
            break;

        case 'error':
            onError?.(message || 'Unknown error');
            break;

        case 'mcp-response':
            // Handled by callTool's inline handler
            break;
    }
};

// ============ Initialization ============

/**
 * Initialize the sandbox worker.
 */
export function initializeSandbox(): void {
    sandbox.postMessage({ type: 'init' });
}

/**
 * Set callbacks for sandbox events.
 */
export function setSandboxCallbacks(callbacks: {
    onMcpInitialized?: (serverInfo: { name: string; version: string }, tools: Array<{ name: string; description?: string }>) => void;
    onStatus?: (message: string) => void;
    onReady?: () => void;
    onError?: (message: string) => void;
    onConsole?: (message: string) => void;
}): void {
    onMcpInitialized = callbacks.onMcpInitialized || null;
    onStatus = callbacks.onStatus || null;
    onReady = callbacks.onReady || null;
    onError = callbacks.onError || null;
    onConsole = callbacks.onConsole || null;
}

// ============ Tool Calling ============

/**
 * Call an MCP tool via the sandbox worker.
 */
export async function callTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    return new Promise((resolve) => {
        const id = crypto.randomUUID();
        const requestId = Date.now();

        // Handler for mcp-response messages
        const handler = (event: MessageEvent<SandboxMessage>) => {
            if (event.data.type === 'mcp-response' && event.data.response?.id === requestId) {
                sandbox.removeEventListener('message', handler);
                const response = event.data.response;
                if (response.error) {
                    resolve({ error: response.error.message });
                } else {
                    // Extract text from content array
                    const content = (response.result as any)?.content || [];
                    const output = content.map((c: any) => c.text).filter(Boolean).join('\n');
                    resolve({ output, isError: (response.result as any)?.isError });
                }
            }
        };
        sandbox.addEventListener('message', handler);

        // Send as MCP JSON-RPC request
        sandbox.postMessage({
            type: 'mcp-request',
            id,
            request: {
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: { name, arguments: input }
            }
        });
    });
}

/**
 * Send a generic MCP JSON-RPC request via the sandbox worker.
 * This is the single entry point for ALL MCP communication.
 */
export async function sendMcpRequest(request: {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: Record<string, unknown>;
}): Promise<{
    jsonrpc: '2.0';
    id: number;
    result?: any;
    error?: { code: number; message: string };
}> {
    return new Promise((resolve) => {
        const internalId = crypto.randomUUID();

        // Handler for mcp-response messages
        const handler = (event: MessageEvent<SandboxMessage>) => {
            if (event.data.type === 'mcp-response' && event.data.response?.id === request.id) {
                sandbox.removeEventListener('message', handler);
                // Cast to expected type - worker returns compatible structure
                resolve(event.data.response as any);
            }
        };
        sandbox.addEventListener('message', handler);

        // Send as MCP JSON-RPC request
        sandbox.postMessage({
            type: 'mcp-request',
            id: internalId,
            request
        });
    });
}

/**
 * SSE event from streaming MCP response
 */
export interface StreamEvent {
    event?: string;
    data: string;
    id?: string;
}

/**
 * Send a streaming MCP JSON-RPC request via the sandbox worker.
 * This allows receiving progress events during tool execution.
 * 
 * @param request The JSON-RPC request
 * @param onEvent Callback for each streaming event
 * @returns The final JSON-RPC response
 */
export async function sendMcpRequestStreaming(
    request: {
        jsonrpc: '2.0';
        id: number;
        method: string;
        params?: Record<string, unknown>;
    },
    onEvent: (event: StreamEvent) => void
): Promise<{
    jsonrpc: '2.0';
    id: number;
    result?: any;
    error?: { code: number; message: string };
}> {
    return new Promise((resolve, reject) => {
        const internalId = crypto.randomUUID();

        // Handler for streaming events and final response
        const handler = (event: MessageEvent<SandboxMessage & { event?: StreamEvent }>) => {
            // Handle stream events
            if (event.data.type === 'mcp-stream-event' && (event.data as any).requestId === request.id) {
                onEvent((event.data as any).event);
                return; // Don't remove handler, more events may come
            }

            // Handle final response
            if (event.data.type === 'mcp-response' && event.data.response?.id === request.id) {
                sandbox.removeEventListener('message', handler);
                resolve(event.data.response as any);
            }

            // Handle streaming error
            if (event.data.type === 'mcp-stream-error' && event.data.id === internalId) {
                sandbox.removeEventListener('message', handler);
                reject(new Error((event.data as any).error || 'Streaming error'));
            }
        };
        sandbox.addEventListener('message', handler);

        // Send as streaming MCP request
        sandbox.postMessage({
            type: 'mcp-request-streaming',
            id: internalId,
            request
        });
    });
}

