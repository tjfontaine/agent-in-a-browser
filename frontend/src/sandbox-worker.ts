// Sandbox Worker with OPFS + MCP Tools
// Uses the Rust-based WASM MCP server for all tool calls
// OPFS helpers are only used by browser-fs-impl.ts

export { }; // Make this a module

import { callWasmMcpServer, callWasmMcpServerStreaming, SSEEvent, type JsonRpcRequest, type JsonRpcResponse } from './wasm-mcp-bridge';

// OPFS root handle (exported for browser-fs-impl.ts)
let opfsRoot: FileSystemDirectoryHandle | null = null;
let initialized = false;

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
    if (initialized) return;

    console.log('[Sandbox] Initializing...');

    // Initialize OPFS root handle (for legacy helpers)
    opfsRoot = await navigator.storage.getDirectory();
    console.log('[Sandbox] OPFS handle acquired');

    // Initialize OPFS filesystem shim - scans OPFS and populates in-memory tree
    const { initFilesystem } = await import('./wasm/opfs-filesystem-impl');
    await initFilesystem();
    console.log('[Sandbox] OPFS filesystem shim initialized');

    // Initialize MCP by calling initialize on WASM directly
    try {
        const initResponse = await callWasmMcpServer({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
                clientInfo: { name: 'web-agent-frontend', version: '0.1.0' }
            }
        });

        if (initResponse.error) {
            throw new Error(`MCP initialize error: ${initResponse.error.message}`);
        }

        const serverInfo = initResponse.result?.serverInfo;
        console.log('[Sandbox] MCP initialized:', serverInfo);

        // Send initialized notification
        await callWasmMcpServer({
            jsonrpc: '2.0',
            id: 2,
            method: 'initialized',
            params: {}
        });

        // List tools
        const toolsResponse = await callWasmMcpServer({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list',
            params: {}
        });

        const tools = toolsResponse.result?.tools || [];
        console.log('[Sandbox] MCP tools:', tools.map((t: any) => t.name));

        // Send tools list to main thread
        self.postMessage({
            type: 'mcp-initialized',
            serverInfo,
            tools
        });

        initialized = true;
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
                // Passthrough ALL MCP requests directly to WASM bridge
                try {
                    const request = data.request as JsonRpcRequest;
                    const response = await callWasmMcpServer(request);

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

            // Streaming MCP request - emits events as they arrive
            case 'mcp-request-streaming':
                try {
                    const request = data.request as JsonRpcRequest;

                    // Use streaming bridge function - passthrough with callback
                    const response = await callWasmMcpServerStreaming(
                        request,
                        (event: SSEEvent) => {
                            // Emit each streaming event to main thread
                            self.postMessage({
                                type: 'mcp-stream-event',
                                id,
                                requestId: request.id,
                                event
                            });
                        }
                    );

                    // Send final response
                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response
                    });
                } catch (error: any) {
                    self.postMessage({
                        type: 'mcp-stream-error',
                        id,
                        error: error.message
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


