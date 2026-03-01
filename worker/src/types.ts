/**
 * Shared types for the Edge Agent Cloudflare Worker.
 *
 * NOTE: SessionHostname, parseSessionHostname, generateSessionId, and wire protocol
 * types (McpRequestMessage, etc.) are canonical in @tjfontaine/edge-agent-session.
 * This file maintains its own copy because the worker builds outside the pnpm
 * workspace via wrangler.
 */

/** The session subdomain base. Canonical constant — use this instead of hardcoding. */
export const SESSION_DOMAIN = 'sessions.edge-agent.dev';

// ============ Cloudflare Environment ============

export interface Env {
    ASSETS: Fetcher;
    SESSION_RELAY: DurableObjectNamespace;
    API_KEYS: KVNamespace;
}

// ============ Session Hostname Parsing ============

/** Reserved tenant IDs that cannot be created by users */
const RESERVED_TENANTS = new Set(['personal', 'api', 'admin', 'www', 'app']);

export interface SessionHostname {
    sid: string;
    tenantId: string;
}

/**
 * Parse a session hostname: {sid}.{tenantId}.sessions.edge-agent.dev
 * Returns null if the hostname is not a session subdomain.
 */
export function parseSessionHostname(hostname: string): SessionHostname | null {
    const match = hostname.match(/^([^.]+)\.([^.]+)\.sessions\.edge-agent\.dev$/);
    if (!match) return null;
    const [, sid, tenantId] = match;
    return { sid, tenantId };
}

/** Check if a tenant ID is reserved */
export function isReservedTenant(tenantId: string): boolean {
    return RESERVED_TENANTS.has(tenantId);
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

export interface ToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

// ============ Auth Types ============

/** API key record stored in KV. Key = hash(api_key). */
export interface ApiKeyRecord {
    deployerId: string;
    name: string;
    tenantId: string;
    createdAt: string;
}

/** Session token: st_{sessionId}_{secret} */
export interface SessionTokenPayload {
    sessionId: string;
    tenantId: string;
    deployerId: string;
    createdAt: string;
}

/** Request to create a new session via the API */
export interface CreateSessionRequest {
    userId?: string;
}

/** Response from session creation */
export interface CreateSessionResponse {
    sessionId: string;
    tenantId: string;
    sessionToken: string;
    browserUrl: string;
    mcpUrl: string;
    wsUrl: string;
}

// ============ Auth Helpers ============

/**
 * Hash an API key using SHA-256 for storage lookup.
 * API keys are prefixed with "dp_live_" or "dp_test_".
 */
export async function hashApiKey(apiKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random session ID (128-bit hex).
 */
export function generateSessionId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Generate a session token: st_{sessionId}_{secret}
 */
export function generateSessionToken(sessionId: string): string {
    const secretBytes = new Uint8Array(24);
    crypto.getRandomValues(secretBytes);
    const secret = Array.from(secretBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `st_${sessionId}_${secret}`;
}

/**
 * Parse a session token to extract the session ID.
 * Token format: st_{sessionId}_{secret}
 */
export function parseSessionToken(token: string): { sessionId: string; secret: string } | null {
    const match = token.match(/^st_([a-f0-9]+)_([a-f0-9]+)$/);
    if (!match) return null;
    return { sessionId: match[1], secret: match[2] };
}

/**
 * Validate an API key against KV storage.
 * Returns the API key record if valid, null otherwise.
 */
export async function validateApiKey(apiKey: string, kv: KVNamespace): Promise<ApiKeyRecord | null> {
    if (!apiKey.startsWith('dp_live_') && !apiKey.startsWith('dp_test_')) {
        return null;
    }

    const hash = await hashApiKey(apiKey);
    const record = await kv.get<ApiKeyRecord>(hash, 'json');
    return record;
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(request: Request): string | null {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return null;
    return auth.slice(7);
}

/**
 * Extract API key from Authorization header (for deployer API routes).
 * Accepts "Bearer dp_live_xxx" or "dp_live_xxx" directly.
 */
export function extractApiKey(request: Request): string | null {
    const auth = request.headers.get('Authorization');
    if (!auth) return null;

    if (auth.startsWith('Bearer ')) {
        const token = auth.slice(7);
        if (token.startsWith('dp_live_') || token.startsWith('dp_test_')) {
            return token;
        }
        return null;
    }

    if (auth.startsWith('dp_live_') || auth.startsWith('dp_test_')) {
        return auth;
    }

    return null;
}
