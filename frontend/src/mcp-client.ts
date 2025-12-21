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
    inputSchema: Record<string, any>;
}

export interface McpToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export interface JsonRpcRequest {
    jsonrpc: string;
    id: string | number;
    method: string;
    params?: Record<string, any>;
}

export interface JsonRpcResponse {
    jsonrpc: string;
    id?: string | number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}
