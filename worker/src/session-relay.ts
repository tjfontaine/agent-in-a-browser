/**
 * SessionRelay Durable Object
 *
 * Each session (keyed by tenantId:sid) gets one DO instance.
 * It holds the WebSocket connection to the browser sandbox and proxies
 * MCP requests from external clients (Claude Code, headless agents, etc.).
 *
 * Supports both request/response and streaming (SSE) modes.
 */

import { DEFAULT_TOOLS } from './default-tools.js';
import {
    SESSION_DOMAIN,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type McpRequestMessage,
    type McpResponseMessage,
    type McpStreamMessage,
    type StatusMessage,
    type ToolDefinition,
} from './types.js';

/** How long to keep an idle session alive (7 days) */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Timeout for individual MCP requests (60 seconds) */
const REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** For SSE streaming: writer to push intermediate events */
    streamWriter?: WritableStreamDefaultWriter<Uint8Array>;
}

export class SessionRelay implements DurableObject {
    private browserSocket: WebSocket | null = null;
    private pendingRequests = new Map<string, PendingRequest>();
    private cachedToolList: ToolDefinition[] | null = null;
    private browserReady = false;
    private lastActivity = Date.now();
    private sessionId = '';
    private tenantId = '';

    /** Session token — set by deployer-created sessions, null for keyless (personal) sessions */
    private sessionToken: string | null = null;
    /** Deployer ID — tracks which deployer owns this session */
    private deployerId: string | null = null;
    /** User ID — optional, set by deployer at creation */
    private userId: string | null = null;

    constructor(
        private state: DurableObjectState,
        private env: unknown,
    ) {
        // Restore persisted auth state
        state.blockConcurrencyWhile(async () => {
            this.sessionToken = (await state.storage.get<string>('sessionToken')) ?? null;
            this.deployerId = (await state.storage.get<string>('deployerId')) ?? null;
            this.userId = (await state.storage.get<string>('userId')) ?? null;
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Parse session info from headers (set by the Worker router)
        this.sessionId = request.headers.get('X-Session-Id') || this.sessionId;
        this.tenantId = request.headers.get('X-Tenant-Id') || this.tenantId;
        this.lastActivity = Date.now();

        // Schedule TTL alarm
        await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);

        switch (url.pathname) {
            case '/init':
                return this.handleInit(request);
            case '/teardown':
                return this.handleTeardown();
            case '/relay/ws':
                return this.handleWebSocketUpgrade(request);
            case '/relay/status':
                return this.handleStatus();
            case '/mcp':
                return this.handleMcp(request);
            default:
                return new Response('Not found', { status: 404 });
        }
    }

    // ============ Auth + Lifecycle ============

    /**
     * Initialize auth state for a deployer-created session.
     * Called internally by the Worker when POST /api/v1/sessions creates a session.
     */
    private async handleInit(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            action: string;
            sessionToken: string;
            deployerId: string;
            userId?: string;
        };

        if (body.action === 'init-auth') {
            this.sessionToken = body.sessionToken;
            this.deployerId = body.deployerId;
            this.userId = body.userId ?? null;

            // Persist auth state
            await this.state.storage.put('sessionToken', this.sessionToken);
            await this.state.storage.put('deployerId', this.deployerId);
            if (this.userId) {
                await this.state.storage.put('userId', this.userId);
            }

            return corsJsonResponse({ ok: true });
        }

        return corsJsonResponse({ error: 'Unknown action' }, 400);
    }

    /**
     * Teardown this session — close all connections and delete storage.
     */
    private async handleTeardown(): Promise<Response> {
        if (this.browserSocket) {
            try {
                this.browserSocket.close(1000, 'Session deleted');
            } catch {
                // Ignore
            }
        }
        this.failAllPending('Session deleted');
        await this.state.storage.deleteAll();

        return corsJsonResponse({ ok: true });
    }

    /**
     * Validate the session token from an incoming request.
     * If this session has a token (deployer-created), the request must provide it.
     * Keyless sessions (no deployer) allow unauthenticated access.
     */
    private validateToken(request: Request): boolean {
        // Keyless session — no auth required
        if (!this.sessionToken) {
            return true;
        }

        // Token required — check header
        const providedToken = request.headers.get('X-Session-Token');
        return providedToken === this.sessionToken;
    }

    // ============ WebSocket (Browser Connection) ============

    private handleWebSocketUpgrade(request: Request): Response {
        // Validate token for deployer-owned sessions
        if (!this.validateToken(request)) {
            return corsResponse(401, { error: 'Invalid or missing session token' });
        }

        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
            return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];

        // Close previous browser connection if any (one browser per session)
        if (this.browserSocket) {
            try {
                this.browserSocket.close(1000, 'Replaced by new connection');
            } catch {
                // Socket may already be closed
            }
            this.failAllPending('Browser reconnected');
        }

        this.state.acceptWebSocket(server);
        this.browserSocket = server;
        this.browserReady = false;

        return new Response(null, { status: 101, webSocket: client });
    }

    /** Hibernatable WebSocket: message handler */
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        this.lastActivity = Date.now();

        const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as
            | McpResponseMessage
            | McpStreamMessage
            | StatusMessage;

        switch (data.type) {
            case 'mcp_response':
                this.handleMcpResponse(data);
                break;

            case 'mcp_stream':
                this.handleMcpStream(data);
                break;

            case 'status':
                this.browserReady = data.ready;
                if (data.tools) {
                    this.cachedToolList = data.tools;
                }
                break;
        }
    }

    /** Hibernatable WebSocket: close handler */
    async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        if (ws === this.browserSocket) {
            this.browserSocket = null;
            this.browserReady = false;
            this.failAllPending('Browser disconnected');
        }
    }

    /** Hibernatable WebSocket: error handler */
    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        if (ws === this.browserSocket) {
            this.browserSocket = null;
            this.browserReady = false;
            this.failAllPending('Browser WebSocket error');
        }
    }

    /** Alarm handler: clean up expired sessions */
    async alarm(): Promise<void> {
        const elapsed = Date.now() - this.lastActivity;
        if (elapsed >= SESSION_TTL_MS) {
            if (this.browserSocket) {
                try {
                    this.browserSocket.close(1000, 'Session expired');
                } catch {
                    // Ignore
                }
            }
            this.failAllPending('Session expired');
            await this.state.storage.deleteAll();
        } else {
            // Reschedule alarm for remaining TTL
            await this.state.storage.setAlarm(Date.now() + (SESSION_TTL_MS - elapsed));
        }
    }

    // ============ MCP Request Handling ============

    private async handleMcp(request: Request): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return corsResponse(204);
        }

        if (request.method !== 'POST') {
            return corsResponse(405, { error: 'Method not allowed' });
        }

        // Validate token for deployer-owned sessions
        if (!this.validateToken(request)) {
            return corsResponse(401, { error: 'Invalid or missing session token' });
        }

        const body = (await request.json()) as JsonRpcRequest;
        const { method, id } = body;

        // Check if client wants SSE streaming
        const wantsStream = request.headers.get('Accept')?.includes('text/event-stream') ?? false;

        switch (method) {
            case 'initialize':
                return this.handleInitialize(body);
            case 'initialized':
                return corsJsonResponse({ jsonrpc: '2.0', result: {}, id: id ?? null });
            case 'ping':
                return corsJsonResponse({ jsonrpc: '2.0', result: {}, id: id ?? null });
            case 'tools/list':
                return this.handleToolsList(body);
            case 'tools/call':
                return this.handleToolsCall(body, wantsStream);
            default:
                return this.forwardToBrowser(body, wantsStream);
        }
    }

    private handleInitialize(request: JsonRpcRequest): Response {
        const sessionUrl = this.getSessionUrl();
        const connected = this.browserSocket !== null && this.browserReady;

        let instructions: string;
        if (connected) {
            instructions = [
                `Edge Agent sandbox connected at ${sessionUrl}`,
                'Available: shell (50+ POSIX commands), filesystem, TypeScript, SQLite',
                "All execution happens in the user's browser — no data leaves their machine.",
            ].join('\n');
        } else {
            instructions = [
                `You are connected to Edge Agent at ${sessionUrl} — a browser sandbox with shell, filesystem, TypeScript, and SQLite.`,
                '',
                'Status: browser sandbox not connected.',
                `Ask the user to open ${sessionUrl} in their browser.`,
                'Once loaded, all tools become available.',
                'The sandbox runs entirely client-side — no data leaves their machine.',
            ].join('\n');
        }

        return corsJsonResponse({
            jsonrpc: '2.0',
            result: {
                protocolVersion: '2025-03-26',
                capabilities: {
                    tools: { listChanged: true },
                },
                serverInfo: {
                    name: 'edge-agent',
                    version: '0.1.0',
                },
                instructions,
            },
            id: request.id ?? null,
        });
    }

    private async handleToolsList(request: JsonRpcRequest): Promise<Response> {
        // If browser connected, forward and cache the response
        if (this.browserSocket && this.browserReady) {
            try {
                const response = await this.sendToBrowserAndWait(request);
                // Cache the tools list from the response
                if (response.result && typeof response.result === 'object' && 'tools' in response.result) {
                    this.cachedToolList = (response.result as { tools: ToolDefinition[] }).tools;
                }
                return corsJsonResponse(response);
            } catch {
                // Fall through to cached/default
            }
        }

        // Return cached tools or defaults
        const tools = this.cachedToolList ?? DEFAULT_TOOLS;
        return corsJsonResponse({
            jsonrpc: '2.0',
            result: { tools },
            id: request.id ?? null,
        });
    }

    private async handleToolsCall(request: JsonRpcRequest, wantsStream: boolean): Promise<Response> {
        if (!this.browserSocket || !this.browserReady) {
            return this.browserDisconnectedError(request);
        }

        if (wantsStream) {
            return this.forwardToBrowserStreaming(request);
        }

        try {
            const response = await this.sendToBrowserAndWait(request);
            return corsJsonResponse(response);
        } catch (error) {
            return corsJsonResponse({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : 'Request failed',
                },
                id: request.id ?? null,
            });
        }
    }

    /** Forward any unhandled method to browser */
    private async forwardToBrowser(request: JsonRpcRequest, wantsStream: boolean): Promise<Response> {
        if (!this.browserSocket || !this.browserReady) {
            return this.browserDisconnectedError(request);
        }

        if (wantsStream) {
            return this.forwardToBrowserStreaming(request);
        }

        try {
            const response = await this.sendToBrowserAndWait(request);
            return corsJsonResponse(response);
        } catch (error) {
            return corsJsonResponse({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : 'Request failed',
                },
                id: request.id ?? null,
            });
        }
    }

    // ============ Browser Communication ============

    /**
     * Send an MCP request to the browser and wait for the response.
     */
    private sendToBrowserAndWait(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        return new Promise((resolve, reject) => {
            const reqId = crypto.randomUUID();

            const timer = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error('Request timed out'));
            }, REQUEST_TIMEOUT_MS);

            this.pendingRequests.set(reqId, { resolve, reject, timer });

            const message: McpRequestMessage = {
                type: 'mcp_request',
                id: reqId,
                body: request,
            };

            this.browserSocket!.send(JSON.stringify(message));
        });
    }

    /**
     * Forward an MCP request to the browser with SSE streaming response.
     */
    private forwardToBrowserStreaming(request: JsonRpcRequest): Response {
        const reqId = crypto.randomUUID();
        const encoder = new TextEncoder();

        const { readable, writable } = new TransformStream<Uint8Array>();
        const writer = writable.getWriter();

        const timer = setTimeout(() => {
            const pending = this.pendingRequests.get(reqId);
            if (pending) {
                this.pendingRequests.delete(reqId);
                const errorEvent = `event: message\ndata: ${JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Request timed out' },
                    id: request.id ?? null,
                })}\n\n`;
                writer.write(encoder.encode(errorEvent)).then(() => writer.close());
            }
        }, REQUEST_TIMEOUT_MS);

        const resolve = (response: JsonRpcResponse) => {
            const event = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
            writer.write(encoder.encode(event)).then(() => writer.close());
        };

        const reject = (error: Error) => {
            const errorResponse: JsonRpcResponse = {
                jsonrpc: '2.0',
                error: { code: -32000, message: error.message },
                id: request.id ?? null,
            };
            const event = `event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`;
            writer.write(encoder.encode(event)).then(() => writer.close());
        };

        this.pendingRequests.set(reqId, { resolve, reject, timer, streamWriter: writer });

        const message: McpRequestMessage = {
            type: 'mcp_request',
            id: reqId,
            body: request,
        };

        this.browserSocket!.send(JSON.stringify(message));

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
            },
        });
    }

    private handleMcpResponse(data: McpResponseMessage): void {
        const pending = this.pendingRequests.get(data.id);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingRequests.delete(data.id);
        pending.resolve(data.body);
    }

    private handleMcpStream(data: McpStreamMessage): void {
        const pending = this.pendingRequests.get(data.id);
        if (!pending?.streamWriter) return;

        const encoder = new TextEncoder();
        const event = `event: message\ndata: ${JSON.stringify(data.data)}\n\n`;
        pending.streamWriter.write(encoder.encode(event));
    }

    // ============ Helpers ============

    private browserDisconnectedError(request: JsonRpcRequest): Response {
        const sessionUrl = this.getSessionUrl();
        return corsJsonResponse({
            jsonrpc: '2.0',
            result: {
                content: [
                    {
                        type: 'text',
                        text: [
                            'Browser sandbox not connected.',
                            `Ask the user to open ${sessionUrl} in their browser.`,
                            'The sandbox runs entirely client-side — once they open the page, tools will be available.',
                        ].join('\n'),
                    },
                ],
                isError: true,
            },
            id: request.id ?? null,
        });
    }

    private failAllPending(reason: string): void {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    private getSessionUrl(): string {
        if (this.sessionId && this.tenantId) {
            return `https://${this.sessionId}.${this.tenantId}.${SESSION_DOMAIN}`;
        }
        return 'https://agent.edge-agent.dev';
    }

    private handleStatus(): Response {
        return corsJsonResponse({
            sessionId: this.sessionId,
            tenantId: this.tenantId,
            browserConnected: this.browserSocket !== null,
            browserReady: this.browserReady,
            lastActivity: this.lastActivity,
            toolsCached: this.cachedToolList !== null,
            toolCount: (this.cachedToolList ?? DEFAULT_TOOLS).length,
            hasAuth: this.sessionToken !== null,
            deployerId: this.deployerId,
        });
    }
}

// ============ Response Helpers ============

function corsJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
        },
    });
}

function corsResponse(status: number, body?: unknown): Response {
    const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    };

    if (body) {
        headers['Content-Type'] = 'application/json';
        return new Response(JSON.stringify(body), { status, headers });
    }

    return new Response(null, { status, headers });
}
