/**
 * MCP Protocol Type Definitions
 */

export interface McpServerInfo {
    name: string;
    version: string;
}

export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export interface JsonRpcRequest {
    jsonrpc: string;
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: string;
    id?: string | number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
