/**
 * Cloud mode — forwards MCP requests over HTTP to the cloud relay.
 *
 * The relay (Cloudflare Durable Object) holds the WebSocket to the browser.
 * This mode just POSTs JSON-RPC to https://{sid}.{tenantId}.sessions.edge-agent.dev/mcp.
 */

import type { Config } from '../config.js';
import { getSessionUrls } from '../config.js';
import { generateInstructions, generateDisconnectedToolError } from '../negotiate.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../stdio.js';
import { log } from '../stdio.js';

// Default tool list (matches runtime/src/lib.rs)
const DEFAULT_TOOLS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'The path parameter' } },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file at the given path. Creates parent directories if needed.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
                content: { type: 'string', description: 'The content parameter' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'list',
        description: 'List files and directories at the given path.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'The path parameter' } },
            required: [],
        },
    },
    {
        name: 'grep',
        description: 'Search for a pattern in files under the given path.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The pattern parameter' },
                path: { type: 'string', description: 'The path parameter' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'shell_eval',
        description:
            "Execute shell commands with pipe support. Supports 50+ commands including: echo, ls, cat, grep, sed, awk, jq, curl, sqlite3, tsx, tar, gzip, and more. Example: 'ls /data | head -n 5'",
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string', description: 'The command parameter' } },
            required: ['command'],
        },
    },
    {
        name: 'edit_file',
        description:
            'Edit a file by replacing old_str with new_str. The old_str must match exactly and uniquely in the file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
                old_str: { type: 'string', description: 'The old_str parameter' },
                new_str: { type: 'string', description: 'The new_str parameter' },
            },
            required: ['path', 'old_str', 'new_str'],
        },
    },
];

export function createCloudHandler(config: Config): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
    const { mcpUrl, sessionUrl } = getSessionUrls(config);

    return async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
        const { method, id } = request;

        // Handle initialize locally — inject instructions
        if (method === 'initialize') {
            // Probe relay status to know if browser is connected
            const browserConnected = await probeBrowserConnected(config);

            return {
                jsonrpc: '2.0',
                result: {
                    protocolVersion: '2025-03-26',
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'edge-agent', version: '0.1.0' },
                    instructions: generateInstructions({
                        mode: 'cloud',
                        sessionUrl,
                        browserConnected,
                    }),
                },
                id: id ?? null,
            };
        }

        // Notifications (no id) don't need a response
        if (method === 'initialized') {
            return null;
        }

        if (method === 'ping') {
            return { jsonrpc: '2.0', result: {}, id: id ?? null };
        }

        // Forward everything else to the relay
        try {
            log(`→ ${method} (cloud: ${mcpUrl})`);
            const response = await fetch(mcpUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const text = await response.text();
                log(`← ${response.status}: ${text.slice(0, 200)}`);

                // If relay returns 503 (browser not connected), return guided error
                if (response.status === 503 && method === 'tools/call') {
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
                    error: { code: -32000, message: `Relay returned ${response.status}: ${text.slice(0, 200)}` },
                    id: id ?? null,
                };
            }

            return (await response.json()) as JsonRpcResponse;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`Error: ${message}`);

            // For tools/list, return defaults even if relay is unreachable
            if (method === 'tools/list') {
                return {
                    jsonrpc: '2.0',
                    result: { tools: DEFAULT_TOOLS },
                    id: id ?? null,
                };
            }

            return {
                jsonrpc: '2.0',
                error: { code: -32000, message: `Cloud relay error: ${message}` },
                id: id ?? null,
            };
        }
    };
}

/**
 * Check if the browser sandbox is currently connected to the relay.
 */
async function probeBrowserConnected(config: Config): Promise<boolean> {
    try {
        const { sessionUrl } = getSessionUrls(config);
        const statusUrl = `${sessionUrl}/relay/status`;
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return false;
        const data = (await response.json()) as { browserConnected?: boolean };
        return data.browserConnected === true;
    } catch {
        return false;
    }
}
