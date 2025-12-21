// Sandbox Worker with OPFS + MCP Tools
// Uses the Rust-based WASM MCP server for all tool calls
// OPFS helpers are only used by browser-fs-impl.ts

export { }; // Make this a module

import { createWasmMcpClient, McpClient, JsonRpcRequest, JsonRpcResponse } from './mcp-client';

// MCP Client
let mcpClient: McpClient | null = null;

// OPFS root handle (exported for browser-fs-impl.ts)
let opfsRoot: FileSystemDirectoryHandle | null = null;

// Extend FileSystemDirectoryHandle for entries() support
declare global {
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }
}

// ============ OPFS Helpers (used by browser-fs-impl.ts) ============

export async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p);
    let current: FileSystemDirectoryHandle = opfsRoot;

    for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i], { create });
    }

    return await current.getFileHandle(parts[parts.length - 1], { create });
}

export async function getDirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    if (path === '/' || path === '') return opfsRoot;

    const parts = path.split('/').filter(p => p);
    let current: FileSystemDirectoryHandle = opfsRoot;

    for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create });
    }

    return current;
}

export function getOpfsRoot(): FileSystemDirectoryHandle | null {
    return opfsRoot;
}

// ============ Initialization ============

async function initialize(): Promise<void> {
    console.log('[Sandbox] Initializing...');

    // Initialize OPFS root handle (for legacy helpers)
    opfsRoot = await navigator.storage.getDirectory();
    console.log('[Sandbox] OPFS handle acquired');

    // Initialize OPFS filesystem shim - scans OPFS and populates in-memory tree
    const { initFilesystem } = await import('./wasm/opfs-filesystem-impl');
    await initFilesystem();
    console.log('[Sandbox] OPFS filesystem shim initialized');

    // Initialize MCP Client - using direct WASM bridge
    // The WASM component is loaded and executed in-process via the bridge
    mcpClient = await createWasmMcpClient();

    try {
        const serverInfo = await mcpClient.initialize();
        console.log('[Sandbox] MCP initialized:', serverInfo);

        const tools = await mcpClient.listTools();
        console.log('[Sandbox] MCP tools:', tools);

        // Send tools list to main thread
        self.postMessage({
            type: 'mcp-initialized',
            serverInfo,
            tools
        });
    } catch (error) {
        console.error('[Sandbox] MCP initialization failed:', error);
        // Continue without MCP - graceful degradation
    }
}

// ============ Message Handler ============

self.onmessage = async (event: MessageEvent) => {
    const { type, id, ...data } = event.data;

    try {
        switch (type) {
            case 'init':
                await initialize();
                self.postMessage({ type: 'init_complete', id });
                break;

            case 'mcp-request':
                // Forward MCP requests to the WASM MCP server
                if (!mcpClient) {
                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response: {
                            jsonrpc: '2.0',
                            id: data.request.id,
                            error: {
                                code: -32000,
                                message: 'MCP client not initialized'
                            }
                        }
                    });
                    break;
                }

                try {
                    const request = data.request as JsonRpcRequest;
                    let response: JsonRpcResponse;

                    // Route to appropriate MCP method
                    switch (request.method) {
                        case 'tools/call': {
                            const result = await mcpClient.callTool(
                                request.params?.name || '',
                                request.params?.arguments || {}
                            );
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                result
                            };
                            break;
                        }
                        case 'tools/list': {
                            const tools = await mcpClient.listTools();
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                result: { tools }
                            };
                            break;
                        }
                        default:
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                error: {
                                    code: -32601,
                                    message: `Method not found: ${request.method}`
                                }
                            };
                    }

                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response
                    });
                } catch (error: any) {
                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response: {
                            jsonrpc: '2.0',
                            id: data.request.id,
                            error: {
                                code: -32000,
                                message: error.message
                            }
                        }
                    });
                }
                break;

            default:
                self.postMessage({ type: 'error', id, message: `Unknown message type: ${type}` });
        }
    } catch (e: any) {
        self.postMessage({ type: 'error', id, message: e.message });
    }
};

// Start
initialize().catch(err => {
    self.postMessage({ type: 'error', message: `Init failed: ${err.message}` });
});
