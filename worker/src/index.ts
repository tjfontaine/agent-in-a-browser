/**
 * Edge Agent Cloudflare Worker
 *
 * Routes:
 * - agent.edge-agent.dev         → Main app (static assets with COOP/COEP headers)
 * - {sid}.{tid}.sessions.edge-agent.dev/mcp         → MCP endpoint (→ SessionRelay DO)
 * - {sid}.{tid}.sessions.edge-agent.dev/relay/ws     → Browser WebSocket (→ DO)
 * - {sid}.{tid}.sessions.edge-agent.dev/relay/status → Health check (→ DO)
 * - {sid}.{tid}.sessions.edge-agent.dev/*            → Frontend app (static assets)
 * - /cors-proxy                                       → CORS proxy (allowlisted domains)
 */

import type { Env, CreateSessionRequest, CreateSessionResponse } from './types.js';
import {
    SESSION_DOMAIN,
    parseSessionHostname,
    extractApiKey,
    extractBearerToken,
    validateApiKey,
    generateSessionId,
    generateSessionToken,
} from './types.js';

// Re-export the Durable Object class so Wrangler can find it
export { SessionRelay } from './session-relay.js';

// ============ CORS Proxy (preserved from index.js) ============

const CORS_PROXY_ALLOWLIST = [
    'mcp.stripe.com',
    'access.stripe.com',
    'api.githubcopilot.com',
    'github.com',
    'generativelanguage.googleapis.com',
];

const ALLOWED_ORIGINS = [
    'https://agent.edge-agent.dev',
    'http://localhost:3000',
    'http://localhost:4173',
];

function isAllowedHost(hostname: string): boolean {
    return CORS_PROXY_ALLOWLIST.includes(hostname);
}

function isAllowedOrigin(origin: string | null, request: Request): boolean {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        return true;
    }

    // Allow session subdomains as origins
    if (origin) {
        try {
            const originUrl = new URL(origin);
            if (parseSessionHostname(originUrl.hostname)) {
                return true;
            }
        } catch {
            // Invalid origin URL
        }
    }

    // For null/missing origins (Web Workers), require custom header
    if (!origin || origin === 'null') {
        return request.headers.get('X-Agent-Proxy') === 'web-agent';
    }

    return false;
}

async function handleCorsProxy(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (!isAllowedOrigin(origin, request)) {
        return new Response('Origin not allowed', { status: 403 });
    }

    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Method not allowed', { status: 405 });
    }

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': origin || '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    let target: URL;
    try {
        target = new URL(targetUrl);
    } catch {
        return new Response('Invalid url parameter', { status: 400 });
    }

    if (!isAllowedHost(target.hostname)) {
        return new Response(`Host not allowed: ${target.hostname}`, { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');

    try {
        const response = await fetch(targetUrl, {
            method: request.method,
            headers,
            body: request.body,
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Access-Control-Allow-Origin', origin || '*');
        responseHeaders.set('Access-Control-Expose-Headers', '*');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Proxy error: ${message}`, { status: 502 });
    }
}

// ============ Static Assets with COOP/COEP ============

async function serveAssets(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);

    // Cross-origin isolation headers for SharedArrayBuffer + OPFS
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// ============ Session API (/api/v1/) ============

/**
 * Handle session management API routes.
 * These are served on `sessions.edge-agent.dev/api/v1/...`
 * and require deployer API key authentication.
 */
async function handleSessionApi(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
        return apiCorsResponse(204);
    }

    // POST /api/v1/sessions — Create a new session
    if (pathname === '/api/v1/sessions' && request.method === 'POST') {
        return handleCreateSession(request, env);
    }

    // GET /api/v1/sessions/:id/status — Session health
    const statusMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/status$/);
    if (statusMatch && request.method === 'GET') {
        return handleSessionStatus(request, env, statusMatch[1]);
    }

    // DELETE /api/v1/sessions/:id — Teardown session
    const deleteMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (deleteMatch && request.method === 'DELETE') {
        return handleDeleteSession(request, env, deleteMatch[1]);
    }

    return apiCorsResponse(404, { error: 'Not found' });
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
    // Validate API key
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return apiCorsResponse(401, { error: 'Missing API key. Provide Authorization: Bearer dp_live_xxx' });
    }

    const keyRecord = await validateApiKey(apiKey, env.API_KEYS);
    if (!keyRecord) {
        return apiCorsResponse(401, { error: 'Invalid API key' });
    }

    // Parse request body
    let body: CreateSessionRequest = {};
    try {
        body = (await request.json()) as CreateSessionRequest;
    } catch {
        // Empty body is fine — userId is optional
    }

    // Generate session
    const sessionId = generateSessionId();
    const tenantId = keyRecord.tenantId;
    const sessionToken = generateSessionToken(sessionId);

    // Create the DO instance and initialize it with auth info
    const doId = env.SESSION_RELAY.idFromName(`${tenantId}:${sessionId}`);
    const stub = env.SESSION_RELAY.get(doId);

    // Initialize the DO with deployer info and token
    const initRequest = new Request('https://internal/init', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Session-Id': sessionId,
            'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({
            action: 'init-auth',
            sessionToken,
            deployerId: keyRecord.deployerId,
            userId: body.userId,
        }),
    });
    await stub.fetch(initRequest);

    const baseUrl = `https://${sessionId}.${tenantId}.${SESSION_DOMAIN}`;

    const response: CreateSessionResponse = {
        sessionId,
        tenantId,
        sessionToken,
        browserUrl: baseUrl,
        mcpUrl: `${baseUrl}/mcp`,
        wsUrl: `wss://${sessionId}.${tenantId}.${SESSION_DOMAIN}/relay/ws`,
    };

    return apiCorsResponse(201, response);
}

async function handleSessionStatus(request: Request, env: Env, sessionId: string): Promise<Response> {
    // Validate API key
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return apiCorsResponse(401, { error: 'Missing API key' });
    }

    const keyRecord = await validateApiKey(apiKey, env.API_KEYS);
    if (!keyRecord) {
        return apiCorsResponse(401, { error: 'Invalid API key' });
    }

    const tenantId = keyRecord.tenantId;
    const doId = env.SESSION_RELAY.idFromName(`${tenantId}:${sessionId}`);
    const stub = env.SESSION_RELAY.get(doId);

    // Forward status request to DO
    const statusRequest = new Request(`https://internal/relay/status`, {
        headers: {
            'X-Session-Id': sessionId,
            'X-Tenant-Id': tenantId,
        },
    });

    const doResponse = await stub.fetch(statusRequest);
    const statusBody = await doResponse.json();

    return apiCorsResponse(200, statusBody);
}

async function handleDeleteSession(request: Request, env: Env, sessionId: string): Promise<Response> {
    // Validate API key
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return apiCorsResponse(401, { error: 'Missing API key' });
    }

    const keyRecord = await validateApiKey(apiKey, env.API_KEYS);
    if (!keyRecord) {
        return apiCorsResponse(401, { error: 'Invalid API key' });
    }

    const tenantId = keyRecord.tenantId;
    const doId = env.SESSION_RELAY.idFromName(`${tenantId}:${sessionId}`);
    const stub = env.SESSION_RELAY.get(doId);

    // Send teardown request to DO
    const teardownRequest = new Request('https://internal/teardown', {
        method: 'POST',
        headers: {
            'X-Session-Id': sessionId,
            'X-Tenant-Id': tenantId,
        },
    });
    await stub.fetch(teardownRequest);

    return apiCorsResponse(200, { deleted: true, sessionId });
}

function apiCorsResponse(status: number, body?: unknown): Response {
    const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (body) {
        headers['Content-Type'] = 'application/json';
        return new Response(JSON.stringify(body), { status, headers });
    }

    return new Response(null, { status, headers });
}

// ============ Session Request Router ============

async function routeToSessionRelay(
    request: Request,
    env: Env,
    sid: string,
    tenantId: string,
): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Only route session-specific paths to the DO
    if (pathname === '/mcp' || pathname.startsWith('/relay/')) {
        const doId = env.SESSION_RELAY.idFromName(`${tenantId}:${sid}`);
        const stub = env.SESSION_RELAY.get(doId);

        // Forward with session metadata headers
        const doRequest = new Request(request.url, request);
        doRequest.headers.set('X-Session-Id', sid);
        doRequest.headers.set('X-Tenant-Id', tenantId);

        // Pass through Authorization/token for DO-level auth validation
        const bearerToken = extractBearerToken(request);
        if (bearerToken) {
            doRequest.headers.set('X-Session-Token', bearerToken);
        }
        // Also check for ?token= query param (WebSocket auth)
        const queryToken = url.searchParams.get('token');
        if (queryToken) {
            doRequest.headers.set('X-Session-Token', queryToken);
        }

        return stub.fetch(doRequest);
    }

    // Everything else on session subdomains → static assets (frontend app)
    return serveAssets(request, env);
}

// ============ Worker Entry Point ============

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Check if this is a session subdomain request
        const session = parseSessionHostname(url.hostname);
        if (session) {
            return routeToSessionRelay(request, env, session.sid, session.tenantId);
        }

        // Session management API routes (on sessions.edge-agent.dev)
        if (
            url.hostname === SESSION_DOMAIN &&
            url.pathname.startsWith('/api/v1/')
        ) {
            return handleSessionApi(request, env);
        }

        // CORS proxy route (works on any hostname)
        if (url.pathname === '/cors-proxy') {
            return handleCorsProxy(request);
        }

        // Default: serve static assets with COOP/COEP headers
        return serveAssets(request, env);
    },
};
