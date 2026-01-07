#!/usr/bin/env npx tsx
/**
 * MCP Transport Bridge: HTTP ↔ WebSocket Proxy
 * 
 * This is a DUMB PROXY. It:
 * - Accepts HTTP POST requests from Claude Desktop on port 3050
 * - Forwards them verbatim over WebSocket to the browser on port 3040
 * - Returns the browser's response verbatim to Claude
 * 
 * The browser runs @tjfontaine/mcp-wasm-server which speaks MCP natively.
 * It receives HTTP-like Request data and returns HTTP-like Response data.
 * 
 * Usage:
 *   cd tools/mcp-bridge && npm install && npm start
 * 
 * Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "browser-sandbox": {
 *         "url": "http://localhost:3050/mcp"
 *       }
 *     }
 *   }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const WS_PORT = parseInt(process.env.WS_PORT || '3040', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3050', 10);

// Track connected browser client
let browserClient: WebSocket | null = null;

// Pending HTTP responses waiting for WebSocket reply
// Key is a unique request ID we generate
const pendingResponses = new Map<number, ServerResponse>();
let nextRequestId = 1;

// ============================================================================
// WebSocket Server (Browser connects here)
// ============================================================================

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
    console.log('[Bridge] Browser connected via WebSocket');
    browserClient = ws;

    ws.on('message', (data) => {
        const message = data.toString();
        console.log('[Bridge] ← Browser:', message.slice(0, 200));

        // Protocol: "REQ_ID:HTTP_STATUS:BODY"
        // e.g., "1:200:{...json...}"
        const firstColon = message.indexOf(':');
        const secondColon = message.indexOf(':', firstColon + 1);

        if (firstColon === -1 || secondColon === -1) {
            console.error('[Bridge] Invalid message format');
            return;
        }

        const reqId = parseInt(message.slice(0, firstColon), 10);
        const status = parseInt(message.slice(firstColon + 1, secondColon), 10);
        const body = message.slice(secondColon + 1);

        const res = pendingResponses.get(reqId);
        if (res) {
            pendingResponses.delete(reqId);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body);
        } else {
            console.error('[Bridge] No pending response for request ID:', reqId);
        }
    });

    ws.on('close', () => {
        console.log('[Bridge] Browser disconnected');
        browserClient = null;
        // Fail all pending requests
        for (const [, res] of pendingResponses) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Browser disconnected' },
                id: null
            }));
        }
        pendingResponses.clear();
    });

    ws.on('error', (err) => {
        console.error('[Bridge] WebSocket error:', err);
    });
});

console.log(`[Bridge] WebSocket server listening on ws://localhost:${WS_PORT}`);

// ============================================================================
// HTTP Server (Claude Desktop connects here via Streamable HTTP)
// ============================================================================

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            browserConnected: browserClient !== null
        }));
        return;
    }

    // MCP proxy endpoint - forward everything to browser
    if (req.method === 'POST' && req.url === '/mcp') {
        if (!browserClient || browserClient.readyState !== WebSocket.OPEN) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'No browser connected' },
                id: null
            }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const reqId = nextRequestId++;
            console.log('[Bridge] ← Claude [%d]:', reqId, body.slice(0, 200));

            // Store response for when browser replies
            pendingResponses.set(reqId, res);

            // Forward to browser: "REQ_ID:METHOD:URL:BODY"
            // Browser will call callWasmMcpServerFetch with this
            const wsMessage = `${reqId}:POST:/mcp:${body}`;
            browserClient!.send(wsMessage);

            // Timeout after 60 seconds
            setTimeout(() => {
                if (pendingResponses.has(reqId)) {
                    pendingResponses.delete(reqId);
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Request timed out' },
                        id: null
                    }));
                }
            }, 60000);
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

httpServer.listen(HTTP_PORT, () => {
    console.log(`[Bridge] HTTP server listening on http://localhost:${HTTP_PORT}/mcp`);
    console.log('');
    console.log('Claude Desktop config:');
    console.log(JSON.stringify({
        mcpServers: {
            'browser-sandbox': {
                url: `http://localhost:${HTTP_PORT}/mcp`
            }
        }
    }, null, 2));
    console.log('');
    console.log('Browser must connect to ws://localhost:' + WS_PORT);
    console.log('and use callWasmMcpServerFetch() to handle requests.');
});
