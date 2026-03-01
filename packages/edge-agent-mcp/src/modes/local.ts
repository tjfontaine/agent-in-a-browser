/**
 * Local mode — forwards MCP requests over WebSocket to a local browser.
 *
 * Connects to ws://localhost:{port} where the browser's mcp-bridge or
 * relay client is listening. Uses the same JSON wire protocol as the
 * cloud relay.
 */

import WebSocket from 'ws';
import type { Config } from '../config.js';
import { generateInstructions, generateDisconnectedToolError } from '../negotiate.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../stdio.js';
import { log } from '../stdio.js';

interface PendingRequest {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 60_000;

export function createLocalHandler(config: Config): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
    const wsUrl = `ws://localhost:${config.local.wsPort}`;
    let ws: WebSocket | null = null;
    let connected = false;
    const pending = new Map<string, PendingRequest>();
    let requestCounter = 0;

    function connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            log(`Connecting to ${wsUrl}...`);
            ws = new WebSocket(wsUrl);

            ws.on('open', () => {
                log('Connected to local browser');
                connected = true;
                resolve();
            });

            ws.on('message', (data: WebSocket.Data) => {
                handleMessage(data.toString());
            });

            ws.on('close', () => {
                log('Local browser disconnected');
                connected = false;
                ws = null;
                failAllPending('Browser disconnected');
            });

            ws.on('error', (err: Error) => {
                if (!connected) {
                    reject(err);
                } else {
                    log(`WebSocket error: ${err.message}`);
                }
            });
        });
    }

    function handleMessage(raw: string): void {
        // Support both JSON wire protocol and legacy REQ_ID:STATUS:BODY format
        if (raw.startsWith('{')) {
            // JSON protocol (matches cloud relay)
            try {
                const message = JSON.parse(raw) as { type: string; id: string; body?: JsonRpcResponse; status?: number };
                if (message.type === 'mcp_response' && message.id) {
                    const p = pending.get(message.id);
                    if (p) {
                        clearTimeout(p.timer);
                        pending.delete(message.id);
                        p.resolve(message.body ?? { jsonrpc: '2.0', result: {}, id: null });
                    }
                }
            } catch {
                log(`Invalid JSON message: ${raw.slice(0, 100)}`);
            }
        } else {
            // Legacy format: REQ_ID:STATUS:BODY (backward compat with existing mcp-bridge)
            const firstColon = raw.indexOf(':');
            const secondColon = raw.indexOf(':', firstColon + 1);
            if (firstColon === -1 || secondColon === -1) return;

            const reqId = raw.slice(0, firstColon);
            const body = raw.slice(secondColon + 1);

            const p = pending.get(reqId);
            if (p) {
                clearTimeout(p.timer);
                pending.delete(reqId);
                try {
                    p.resolve(JSON.parse(body) as JsonRpcResponse);
                } catch {
                    p.reject(new Error('Invalid response'));
                }
            }
        }
    }

    function failAllPending(reason: string): void {
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
        pending.clear();
    }

    function sendAndWait(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        return new Promise((resolve, reject) => {
            const reqId = String(++requestCounter);

            const timer = setTimeout(() => {
                pending.delete(reqId);
                reject(new Error('Request timed out'));
            }, REQUEST_TIMEOUT_MS);

            pending.set(reqId, { resolve, reject, timer });

            // Try JSON protocol first
            const message = JSON.stringify({ type: 'mcp_request', id: reqId, body: request });
            ws!.send(message);
        });
    }

    // Session URL for instructions (local mode points to localhost)
    const sessionUrl = `http://localhost:${config.local.wsPort === 3040 ? 3000 : config.local.wsPort}`;

    return async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
        const { method, id } = request;

        if (method === 'initialize') {
            return {
                jsonrpc: '2.0',
                result: {
                    protocolVersion: '2025-03-26',
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'edge-agent', version: '0.1.0' },
                    instructions: generateInstructions({
                        mode: 'local',
                        sessionUrl,
                        browserConnected: connected,
                    }),
                },
                id: id ?? null,
            };
        }

        if (method === 'initialized') return null;
        if (method === 'ping') return { jsonrpc: '2.0', result: {}, id: id ?? null };

        // Ensure connection
        if (!ws || !connected) {
            try {
                await connect();
            } catch {
                if (method === 'tools/call') {
                    return {
                        jsonrpc: '2.0',
                        result: {
                            content: [{ type: 'text', text: generateDisconnectedToolError(sessionUrl) }],
                            isError: true,
                        },
                        id: id ?? null,
                    };
                }
                return {
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Cannot connect to local browser' },
                    id: id ?? null,
                };
            }
        }

        try {
            log(`→ ${method} (local: ${wsUrl})`);
            return await sendAndWait(request);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                jsonrpc: '2.0',
                error: { code: -32000, message },
                id: id ?? null,
            };
        }
    };
}
