/**
 * RelayClient — WebSocket client connecting a browser sandbox to the cloud relay.
 *
 * Protocol:
 *   Relay → Browser: { type: "mcp_request", id, body }
 *   Browser → Relay: { type: "mcp_response", id, status, body }
 *   Browser → Relay: { type: "status", ready: true, tools?: [...] }
 */

import { getRelayWsUrlWithToken, type McpRequestMessage } from './index.js';

export type RelayState = 'disconnected' | 'connecting' | 'connected' | 'ready';

/** Fetch function signature matching the sandbox's MCP server */
export type SandboxFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RelayClientOptions {
    /** Session ID */
    sessionId: string;
    /** Tenant ID */
    tenantId: string;
    /** Sandbox fetch function — routes MCP requests to the WASM server */
    sandboxFetch: SandboxFetch;
    /** Session token for deployer-created sessions */
    sessionToken?: string;
    /** Called whenever the relay state changes */
    onStateChange?: (state: RelayState) => void;
}

/** Max reconnect backoff in ms */
const MAX_BACKOFF_MS = 30_000;

export class RelayClient {
    readonly sessionId: string;
    readonly tenantId: string;
    private sandboxFetch: SandboxFetch;
    private sessionToken?: string;
    private onStateChange?: (state: RelayState) => void;

    private ws: WebSocket | null = null;
    private currentState: RelayState = 'disconnected';
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private intentionalClose = false;

    constructor(options: RelayClientOptions) {
        this.sessionId = options.sessionId;
        this.tenantId = options.tenantId;
        this.sandboxFetch = options.sandboxFetch;
        this.sessionToken = options.sessionToken;
        this.onStateChange = options.onStateChange;
    }

    /** Current connection state */
    get state(): RelayState {
        return this.currentState;
    }

    /**
     * Connect to the relay WebSocket.
     * Returns false if no sessionId is configured.
     */
    connect(): boolean {
        if (!this.sessionId) {
            return false;
        }
        this.intentionalClose = false;
        this.doConnect();
        return true;
    }

    /** Disconnect and stop reconnecting */
    disconnect(): void {
        this.intentionalClose = true;
        this.clearReconnect();

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }

        this.setState('disconnected');
    }

    /**
     * Send a status update to the relay.
     * Call after the sandbox is initialized with the tool list.
     */
    sendStatus(ready: boolean, tools?: unknown[]): void {
        this.send({ type: 'status', ready, tools });
        if (ready) {
            this.setState('ready');
        }
    }

    /** Get the WebSocket URL for this session */
    getWsUrl(): string {
        return getRelayWsUrlWithToken({
            sid: this.sessionId,
            tenantId: this.tenantId,
            token: this.sessionToken,
        });
    }

    // ============ Internal ============

    private doConnect(): void {
        const wsUrl = this.getWsUrl();
        this.setState('connecting');

        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.setState('connected');
        };

        ws.onmessage = (event) => {
            this.handleMessage(event.data as string);
        };

        ws.onclose = () => {
            this.ws = null;
            this.setState('disconnected');

            if (!this.intentionalClose) {
                this.scheduleReconnect();
            }
        };

        ws.onerror = () => {
            // onclose will fire after onerror
        };
    }

    private async handleMessage(raw: string): Promise<void> {
        let message: McpRequestMessage;
        try {
            message = JSON.parse(raw) as McpRequestMessage;
        } catch {
            return;
        }

        if (message.type !== 'mcp_request') return;

        const { id, body } = message;

        try {
            const response = await this.sandboxFetch('/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const status = response.status;
            const responseBody = await response.json();

            this.send({ type: 'mcp_response', id, status, body: responseBody });
        } catch (error) {
            this.send({
                type: 'mcp_response',
                id,
                status: 500,
                body: {
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : String(error),
                    },
                    id: body.id ?? null,
                },
            });
        }
    }

    private send(message: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private setState(state: RelayState): void {
        if (this.currentState === state) return;
        this.currentState = state;
        this.onStateChange?.(state);
    }

    private scheduleReconnect(): void {
        this.clearReconnect();

        const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempts), MAX_BACKOFF_MS);
        this.reconnectAttempts++;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect();
        }, backoff);
    }

    private clearReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
