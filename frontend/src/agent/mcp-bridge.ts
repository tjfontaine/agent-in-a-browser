/**
 * MCP Bridge - Communication with WASM MCP Server
 * 
 * Handles JSON-RPC requests to the MCP server running in the WASM sandbox.
 */

import { fetchFromSandbox } from './sandbox';
import type { McpTool } from '../mcp';

// ============================================================
// STATE
// ============================================================

let cachedTools: McpTool[] = [];
let mcpInitialized = false;

// ============================================================
// MCP JSON-RPC
// ============================================================

/**
 * Send an MCP JSON-RPC request via POST to the sandbox.
 */
export async function mcpRequest(
    method: string,
    params?: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const id = Date.now();
    const request = {
        jsonrpc: '2.0',
        id,
        method,
        params: params || {}
    };

    console.log('[MCP] Request:', method, params);

    const response = await fetchFromSandbox('/mcp/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });

    console.log('[MCP] Response status:', response.status);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`MCP request failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    console.log('[MCP] Response:', result);
    return result;
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Check if the WASM MCP server has been initialized.
 */
export function isMcpInitialized(): boolean {
    return mcpInitialized;
}

/**
 * Get the cached MCP tools.
 */
export function getCachedTools(): McpTool[] {
    return cachedTools;
}

/**
 * Initialize the WASM MCP server and get tools.
 * Returns the list of available tools from the server.
 */
export async function initializeWasmMcp(): Promise<McpTool[]> {
    if (mcpInitialized) {
        return cachedTools;
    }

    console.log('[Agent] Initializing WASM MCP server...');

    // MCP handshake
    const initResult = await mcpRequest('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        clientInfo: { name: 'web-agent', version: '0.1.0' }
    });

    if (initResult.error) {
        throw new Error(`MCP initialize failed: ${initResult.error.message}`);
    }

    console.log('[Agent] MCP Server:', initResult.result?.serverInfo);

    // Send initialized notification
    await mcpRequest('initialized', {});

    // List available tools
    const toolsResult = await mcpRequest('tools/list', {});

    if (toolsResult.error) {
        throw new Error(`Failed to list tools: ${toolsResult.error.message}`);
    }

    cachedTools = (toolsResult.result?.tools as Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {}
    }));

    mcpInitialized = true;

    console.log('[Agent] Available tools:', cachedTools.map(t => t.name));

    return cachedTools;
}

// ============================================================
// TOOL EXECUTION
// ============================================================

/**
 * Call an MCP tool with streaming progress support.
 * Used by the dynamic tool executors in the AI SDK integration.
 * 
 * @param name - Tool name to call
 * @param args - Arguments to pass to the tool
 * @param onProgress - Optional callback for progress updates
 * @returns The tool result as a string
 */
export async function callMcpTool(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (data: string) => void
): Promise<string> {
    console.log('[MCP Tool Call] Tool:', name);

    if (!mcpInitialized) {
        throw new Error('MCP not initialized');
    }

    try {
        const response = await mcpRequest('tools/call', { name, arguments: args });

        if (response.error) {
            throw new Error(response.error.message);
        }

        const result = response.result;
        if (!result) {
            return 'No result';
        }

        // Extract text content from MCP response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = (result as any).content as Array<{ type: string; text?: string }> || [];
        const textContent = content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('\n');

        console.log('[MCP Tool Call] Result:', textContent.substring(0, 100) + '...');
        return textContent;
    } catch (error: unknown) {
        console.error('[MCP Tool Call] Error:', error);
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}
