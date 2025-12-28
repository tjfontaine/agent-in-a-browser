// Sandbox Worker with OPFS + MCP Tools
// Uses the Rust-based WASM MCP server via a fetch-like interface

console.log('[SandboxWorker] Module loading...');

export { }; // Make this a module

import { callWasmMcpServerFetch } from '../mcp/WasmBridge';
import { loadMcpServer } from '../wasm/async-mode';
import { initializeForSyncMode } from '../wasm/lazy-modules';
// Lazy modules load ON-DEMAND in JSPI mode, or eagerly in Sync mode

console.log('[SandboxWorker] Imports complete');

// Signal ready immediately
console.log('[SandboxWorker] Sending ready signal');
self.postMessage({ type: 'ready' });

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
    console.log('[SandboxWorker] initialize() called, initialized:', initialized);
    if (initialized) {
        console.log('[SandboxWorker] Already initialized, returning');
        return;
    }

    console.log('[SandboxWorker] Starting initialization...');

    // Initialize OPFS root handle (for legacy helpers)
    try {
        console.log('[SandboxWorker] Acquiring OPFS handle...');
        opfsRoot = await navigator.storage.getDirectory();
        console.log('[SandboxWorker] OPFS handle acquired');
    } catch (e) {
        console.error('[SandboxWorker] Failed to acquire OPFS handle:', e);
        throw e;
    }

    // Initialize OPFS filesystem shim - scans OPFS and populates in-memory tree
    try {
        console.log('[SandboxWorker] Loading filesystem shim...');
        const { initFilesystem } = await import('../wasm/opfs-filesystem-impl');
        console.log('[SandboxWorker] Calling initFilesystem()...');
        await initFilesystem();
        console.log('[SandboxWorker] OPFS filesystem shim initialized');
    } catch (e) {
        console.error('[SandboxWorker] Failed to initialize filesystem shim:', e);
        throw e;
    }

    // Load MCP server WASM module (JSPI or Sync mode based on browser support)
    try {
        console.log('[SandboxWorker] Loading MCP server module...');
        await loadMcpServer();
        console.log('[SandboxWorker] MCP server module loaded');
    } catch (e) {
        console.error('[SandboxWorker] Failed to load MCP server:', e);
        throw e;
    }

    // In Sync mode (Safari/Firefox), eager-load all lazy modules now
    // In JSPI mode (Chrome), this is a no-op and modules load on-demand
    try {
        console.log('[SandboxWorker] Initializing lazy modules for sync mode...');
        await initializeForSyncMode();
        console.log('[SandboxWorker] Lazy modules initialized');
    } catch (e) {
        console.error('[SandboxWorker] Failed to initialize lazy modules:', e);
        throw e;
    }

    initialized = true;
}

// ============ Message Handler ============

self.onmessage = async (event: MessageEvent) => {
    console.log('[SandboxWorker] Received message:', event.data.type);
    const { type, id, ...data } = event.data;

    try {
        switch (type) {
            case 'init':
                console.log('[SandboxWorker] Handling init message');
                await initialize();
                console.log('[SandboxWorker] Posting init_complete');
                self.postMessage({ type: 'init_complete', id });
                break;

            case 'fetch': {
                // Handle fetch request from main thread via MessageChannel
                console.log('[SandboxWorker] Handling fetch:', data.url, data.method);
                const port = event.ports[0];
                if (!port) {
                    console.error('[SandboxWorker] missing port for fetch');
                    return;
                }

                try {
                    const reqInit: RequestInit = {
                        method: data.method,
                        headers: new Headers(data.headers),
                    };

                    if (data.body) {
                        reqInit.body = data.body;
                    }

                    // Create Request object
                    // Note: 'body' in Request constructor behaves differently depending on environment,
                    // but for text/json it works. For streaming upload, we might need more care.
                    const request = new Request(data.url, reqInit);

                    // Call WASM MCP Bridge
                    const { status, headers: respHeaders, body: respBody } = await callWasmMcpServerFetch(request);

                    // Convert headers to plain object for transfer (or just entries)
                    const headerEntries: [string, string][] = [];
                    respHeaders.forEach((val, key) => headerEntries.push([key, val]));

                    // Send head
                    port.postMessage({
                        type: 'head',
                        payload: {
                            status,
                            statusText: status === 200 ? 'OK' : 'Error', // Minimal status text
                            headers: headerEntries
                        }
                    });

                    // Pipe body
                    const reader = respBody.getReader();
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                port.postMessage({ type: 'end' });
                                break;
                            }
                            port.postMessage({ type: 'chunk', chunk: value }, [value.buffer]);
                        }
                    } catch (readError: unknown) {
                        port.postMessage({ type: 'error', error: readError instanceof Error ? readError.message : String(readError) });
                    } finally {
                        reader.releaseLock();
                        port.close();
                    }

                } catch (error: unknown) {
                    port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
                    port.close();
                }
                break;
            }

            default:
                self.postMessage({ type: 'error', id, message: `Unknown message type: ${type}` });
        }
    } catch (e: unknown) {
        self.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
    }
};



