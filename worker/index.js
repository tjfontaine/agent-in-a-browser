// Worker entry point for serving static assets and CORS proxy
// The ASSETS binding handles all static file serving automatically
// Adds COOP/COEP headers for SharedArrayBuffer support

// Allowlist of domains that can be proxied
const CORS_PROXY_ALLOWLIST = [
    'mcp.stripe.com',
];

/**
 * Check if a hostname is in the proxy allowlist
 */
function isAllowedHost(hostname) {
    return CORS_PROXY_ALLOWLIST.includes(hostname);
}

/**
 * Allowed origins that can use the CORS proxy
 */
const ALLOWED_ORIGINS = [
    'https://agent.edge-agent.dev',
    'http://localhost:3000',  // Vite dev server
    'http://localhost:4173',  // Vite preview server
];

/**
 * Check if an origin is allowed to use the proxy
 */
function isAllowedOrigin(origin) {
    if (!origin) return false;
    return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Handle CORS proxy requests
 * Forwards requests to whitelisted domains and adds CORS headers
 */
async function handleCorsProxy(request) {
    const origin = request.headers.get('Origin');

    // Validate origin - only allow requests from our own domains
    if (!isAllowedOrigin(origin)) {
        return new Response('Origin not allowed', { status: 403 });
    }

    // Only allow POST for MCP requests
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Method not allowed', { status: 405 });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    // Get target URL from query parameter
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    // Parse and validate target URL
    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return new Response('Invalid url parameter', { status: 400 });
    }

    // Check allowlist
    if (!isAllowedHost(target.hostname)) {
        return new Response(`Host not allowed: ${target.hostname}`, { status: 403 });
    }

    // Forward the request
    const headers = new Headers(request.headers);
    // Remove headers that shouldn't be forwarded
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

        // Create response with CORS headers (origin-specific, not wildcard)
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Access-Control-Allow-Origin', origin);
        responseHeaders.set('Access-Control-Expose-Headers', '*');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });
    } catch (err) {
        return new Response(`Proxy error: ${err.message}`, { status: 502 });
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS proxy route
        if (url.pathname === '/cors-proxy') {
            return handleCorsProxy(request);
        }

        // Get the response from the ASSETS binding
        const response = await env.ASSETS.fetch(request);

        // Create new headers, copying all originals
        const headers = new Headers(response.headers);

        // Add cross-origin isolation headers for SharedArrayBuffer support
        // Required for the OPFS async helper worker to use Atomics.wait()
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

        // Return new response with modified headers
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers
        });
    },
};
