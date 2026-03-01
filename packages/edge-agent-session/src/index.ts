/**
 * @tjfontaine/edge-agent-session
 *
 * Shared session types, URL builders, protocol types, and utilities
 * for the Edge Agent relay system.
 *
 * This is the canonical source for:
 * - Session hostname parsing and URL construction
 * - Wire protocol types (relay ↔ browser WebSocket)
 * - Session ID generation
 * - RelayClient (WebSocket client connecting browser sandbox to cloud relay)
 */

// ============ Constants ============

export const DEFAULT_SESSION_DOMAIN = 'sessions.edge-agent.dev';

// ============ Session Types ============

export interface SessionInfo {
    sid: string;
    tenantId: string;
}

// ============ Wire Protocol: DO ↔ Browser WebSocket ============

/** Relay → Browser: execute an MCP request */
export interface McpRequestMessage {
    type: 'mcp_request';
    id: string;
    body: JsonRpcRequest;
}

/** Browser → Relay: final MCP response */
export interface McpResponseMessage {
    type: 'mcp_response';
    id: string;
    status: number;
    body: JsonRpcResponse;
}

/** Browser → Relay: intermediate streaming event */
export interface McpStreamMessage {
    type: 'mcp_stream';
    id: string;
    event: string;
    data: JsonRpcNotification;
}

/** Browser → Relay: sandbox status update */
export interface StatusMessage {
    type: 'status';
    ready: boolean;
    tools?: ToolDefinition[];
}

export type RelayToBrowserMessage = McpRequestMessage;
export type BrowserToRelayMessage = McpResponseMessage | McpStreamMessage | StatusMessage;

// ============ JSON-RPC Types ============

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    result?: unknown;
    error?: JsonRpcError;
    id: string | number | null;
}

export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

// ============ MCP Tool Types ============

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

// ============ Session Hostname Parsing ============

/**
 * Parse a session hostname: {sid}.{tenantId}.sessions.edge-agent.dev
 * Returns null if the hostname is not a session subdomain.
 */
export function parseSessionHostname(hostname: string): SessionInfo | null {
    const match = hostname.match(/^([^.]+)\.([^.]+)\.sessions\.edge-agent\.dev$/);
    if (!match) return null;
    return { sid: match[1], tenantId: match[2] };
}

/**
 * Get session info from the current page's hostname.
 * Returns null if not running in a browser or not on a session subdomain.
 */
export function getCurrentSession(): SessionInfo | null {
    if (typeof window === 'undefined') return null;
    return parseSessionHostname(window.location.hostname);
}

// ============ Session ID Generation ============

/**
 * Generate a random session ID (128-bit hex).
 */
export function generateSessionId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ============ URL Builders ============

export interface SessionUrlOptions {
    sid: string;
    tenantId: string;
    /** Override the domain (default: 'sessions.edge-agent.dev') */
    domain?: string;
}

function buildBase(opts: SessionUrlOptions): string {
    const domain = opts.domain ?? DEFAULT_SESSION_DOMAIN;
    return `${opts.sid}.${opts.tenantId}.${domain}`;
}

/** Build the session base URL: https://{sid}.{tenantId}.sessions.edge-agent.dev */
export function getSessionUrl(opts: SessionUrlOptions): string {
    return `https://${buildBase(opts)}`;
}

/** Build the MCP endpoint URL: https://{sid}.{tenantId}.sessions.edge-agent.dev/mcp */
export function getMcpUrl(opts: SessionUrlOptions): string {
    return `https://${buildBase(opts)}/mcp`;
}

/** Build the WebSocket relay URL: wss://{sid}.{tenantId}.sessions.edge-agent.dev/relay/ws */
export function getRelayWsUrl(opts: SessionUrlOptions): string {
    return `wss://${buildBase(opts)}/relay/ws`;
}

/** Build the WebSocket relay URL with optional token query parameter. */
export function getRelayWsUrlWithToken(opts: SessionUrlOptions & { token?: string }): string {
    let url = `wss://${buildBase(opts)}/relay/ws`;
    if (opts.token) {
        url += `?token=${encodeURIComponent(opts.token)}`;
    }
    return url;
}

// ============ Re-export RelayClient ============

export { RelayClient } from './relay-client.js';
export type { RelayClientOptions, RelayState, SandboxFetch } from './relay-client.js';
