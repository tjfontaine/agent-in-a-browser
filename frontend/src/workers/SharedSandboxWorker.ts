// SharedWorker Sandbox with OPFS + MCP Tools
// Uses SharedWorker for shared module context across all tabs/contexts
// This ensures all code uses the same Pollable class instance

console.log('[SharedSandboxWorker] Module loading...');

import { callWasmMcpServerFetch } from '../mcp/WasmBridge';
import { loadMcpServer } from '../wasm/lazy-loading/async-mode';
import { initializeForSyncMode } from '../wasm/lazy-loading/lazy-modules';

console.log('[SharedSandboxWorker] Imports complete');

// SharedWorkerGlobalScope type
declare const self: SharedWorkerGlobalScope;

// OPFS root handle
let opfsRoot: FileSystemDirectoryHandle | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

// Track all connected ports
const connectedPorts: Set<MessagePort> = new Set();

// Broadcast to all connected clients
function broadcast(message: unknown): void {
    for (const port of connectedPorts) {
        try {
            port.postMessage(message);
        } catch {
            // Port may be closed, remove it
            connectedPorts.delete(port);
        }
    }
}

// ============ OPFS Helpers ============

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
    console.log('[SharedSandboxWorker] initialize() called, initialized:', initialized);
    if (initialized) {
        console.log('[SharedSandboxWorker] Already initialized, returning');
        return;
    }

    if (initializationPromise) {
        console.log('[SharedSandboxWorker] Initialization already in progress, waiting...');
        return initializationPromise;
    }

    console.log('[SharedSandboxWorker] Starting initialization...');

    initializationPromise = (async () => {
        // Initialize OPFS root handle
        try {
            console.log('[SharedSandboxWorker] Acquiring OPFS handle...');
            opfsRoot = await navigator.storage.getDirectory();
            console.log('[SharedSandboxWorker] OPFS handle acquired');
        } catch (e) {
            console.error('[SharedSandboxWorker] Failed to acquire OPFS handle:', e);
            throw e;
        }

        // Initialize OPFS filesystem shim
        try {
            console.log('[SharedSandboxWorker] Loading filesystem shim...');
            const { hasJSPI } = await import('../wasm/lazy-loading/async-mode.js');

            if (hasJSPI) {
                console.log('[SharedSandboxWorker] Using async OPFS shim (JSPI mode)');
                const { initFilesystem } = await import('@tjfontaine/wasi-shims/opfs-filesystem-impl.js');
                await initFilesystem();

                // OPFS root must be set on ALL module instances that have their own copy:
                // 1. directory-tree.js (used by git-module's opfs-git-adapter)
                // 2. main @tjfontaine/wasi-shims bundle (index.js has inlined directory-tree)
                // 3. External /wasi-shims/index.js (served separately, used by edtui/vim)
                const opfsRootHandle = await navigator.storage.getDirectory();

                const directoryTree = await import('@tjfontaine/wasi-shims/directory-tree.js');
                directoryTree.setOpfsRoot(opfsRootHandle);
                console.log('[SharedSandboxWorker] OPFS root set for directory-tree.js');

                // Also set on main bundle (has inlined copy of directory-tree)
                const wasiShims = await import('@tjfontaine/wasi-shims');
                if (wasiShims.setOpfsRoot) {
                    wasiShims.setOpfsRoot(opfsRootHandle);
                    console.log('[SharedSandboxWorker] OPFS root set for main wasi-shims bundle');
                }

                // CRITICAL: Also set on external index.js served at /wasi-shims/index.js
                // This is the module that edtui, vim, and shell actually import at runtime
                try {
                    const externalWasiShims = await import('/wasi-shims/index.js');
                    if (externalWasiShims.setOpfsRoot) {
                        externalWasiShims.setOpfsRoot(opfsRootHandle);
                        console.log('[SharedSandboxWorker] OPFS root set for external /wasi-shims/index.js');
                    }
                } catch (e) {
                    console.warn('[SharedSandboxWorker] Could not set opfsRoot on external index.js:', e);
                }
            } else {
                console.log('[SharedSandboxWorker] Using sync OPFS shim (non-JSPI mode)');
                const { initFilesystem } = await import('@tjfontaine/wasi-shims/opfs-filesystem-sync-impl.js');
                await initFilesystem();

                const opfsRootHandle = await navigator.storage.getDirectory();

                const directoryTree = await import('@tjfontaine/wasi-shims/directory-tree.js');
                directoryTree.setOpfsRoot(opfsRootHandle);
                console.log('[SharedSandboxWorker] OPFS root set for directory-tree.js');

                // Also set on main bundle
                const wasiShims = await import('@tjfontaine/wasi-shims');
                if (wasiShims.setOpfsRoot) {
                    wasiShims.setOpfsRoot(opfsRootHandle);
                    console.log('[SharedSandboxWorker] OPFS root set for main wasi-shims bundle');
                }

                // CRITICAL: Also set on external index.js served at /wasi-shims/index.js
                try {
                    const externalWasiShims = await import('/wasi-shims/index.js');
                    if (externalWasiShims.setOpfsRoot) {
                        externalWasiShims.setOpfsRoot(opfsRootHandle);
                        console.log('[SharedSandboxWorker] OPFS root set for external /wasi-shims/index.js');
                    }
                } catch (e) {
                    console.warn('[SharedSandboxWorker] Could not set opfsRoot on external index.js:', e);
                }
            }
            console.log('[SharedSandboxWorker] OPFS filesystem shim initialized');
        } catch (e) {

            console.error('[SharedSandboxWorker] Failed to initialize filesystem shim:', e);
            throw e;
        }

        // Load MCP server WASM module
        try {
            console.log('[SharedSandboxWorker] Loading MCP server module...');
            await loadMcpServer();
            console.log('[SharedSandboxWorker] MCP server module loaded');
        } catch (e) {
            console.error('[SharedSandboxWorker] Failed to load MCP server:', e);
            throw e;
        }

        // Initialize lazy modules for sync mode
        try {
            console.log('[SharedSandboxWorker] Initializing lazy modules for sync mode...');
            await initializeForSyncMode();
            console.log('[SharedSandboxWorker] Lazy modules initialized');
        } catch (e) {
            console.error('[SharedSandboxWorker] Failed to initialize lazy modules:', e);
            throw e;
        }

        initialized = true;
    })();

    return initializationPromise;
}

// ============ Port Message Handler ============

function handlePortMessage(port: MessagePort, event: MessageEvent): void {
    console.log('[SharedSandboxWorker] Received message:', event.data?.type || 'NO TYPE');
    const { type, id, ...data } = event.data;

    (async () => {
        try {
            switch (type) {
                case 'ping':
                    console.log('[SharedSandboxWorker] Responding to ping with ready');
                    port.postMessage({ type: 'ready' });
                    break;

                case 'init':
                    console.log('[SharedSandboxWorker] Handling init message');
                    await initialize();
                    console.log('[SharedSandboxWorker] Posting init_complete');
                    port.postMessage({ type: 'init_complete', id });
                    break;

                case 'fetch': {
                    console.log('[SharedSandboxWorker] Handling fetch:', data.url, data.method);
                    const transferPort = event.ports[0];
                    if (!transferPort) {
                        console.error('[SharedSandboxWorker] missing port for fetch');
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

                        const request = new Request(data.url, reqInit);
                        const { status, headers: respHeaders, body: respBody } = await callWasmMcpServerFetch(request);

                        const headerEntries: [string, string][] = [];
                        respHeaders.forEach((val, key) => headerEntries.push([key, val]));

                        transferPort.postMessage({
                            type: 'head',
                            payload: {
                                status,
                                statusText: status === 200 ? 'OK' : 'Error',
                                headers: headerEntries
                            }
                        });

                        const reader = respBody.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) {
                                    transferPort.postMessage({ type: 'end' });
                                    break;
                                }
                                transferPort.postMessage({ type: 'chunk', chunk: value }, [value.buffer]);
                            }
                        } catch (readError: unknown) {
                            transferPort.postMessage({ type: 'error', error: readError instanceof Error ? readError.message : String(readError) });
                        } finally {
                            reader.releaseLock();
                            transferPort.close();
                        }

                    } catch (error: unknown) {
                        transferPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
                        transferPort.close();
                    }
                    break;
                }

                case 'fetch-simple': {
                    console.log('[SharedSandboxWorker] Handling fetch-simple:', data.url, data.method);
                    const { requestId, url, method, headers, body } = data;

                    try {
                        const reqInit: RequestInit = {
                            method: method || 'GET',
                            headers: new Headers(headers),
                        };

                        if (body) {
                            reqInit.body = new Uint8Array(body);
                        }

                        const request = new Request(url, reqInit);
                        const { status, headers: respHeaders, body: respBody } = await callWasmMcpServerFetch(request);

                        const reader = respBody.getReader();
                        const chunks: Uint8Array[] = [];
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            chunks.push(value);
                        }
                        reader.releaseLock();

                        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
                        const fullBody = new Uint8Array(totalLength);
                        let offset = 0;
                        for (const chunk of chunks) {
                            fullBody.set(chunk, offset);
                            offset += chunk.length;
                        }

                        const headerEntries: [string, string][] = [];
                        respHeaders.forEach((val, key) => headerEntries.push([key, val]));

                        port.postMessage({
                            type: 'fetch-response',
                            requestId,
                            payload: {
                                status,
                                statusText: status === 200 ? 'OK' : 'Error',
                                headers: headerEntries,
                                body: Array.from(fullBody)
                            }
                        });

                    } catch (error: unknown) {
                        port.postMessage({
                            type: 'fetch-response',
                            requestId,
                            payload: {
                                error: error instanceof Error ? error.message : String(error)
                            }
                        });
                    }
                    break;
                }

                default:
                    port.postMessage({ type: 'error', id, message: `Unknown message type: ${type}` });
            }
        } catch (e: unknown) {
            port.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
        }
    })();
}

// ============ SharedWorker Connection Handler ============

self.onconnect = (event: MessageEvent) => {
    console.log('[SharedSandboxWorker] New connection');
    const port = event.ports[0];
    connectedPorts.add(port);

    port.addEventListener('message', (msgEvent) => {
        handlePortMessage(port, msgEvent);
    });

    port.start();

    // Send ready signal to new connection
    console.log('[SharedSandboxWorker] Sending ready signal to new port');
    port.postMessage({ type: 'ready' });
};

console.log('[SharedSandboxWorker] Module initialized, waiting for connections...');
