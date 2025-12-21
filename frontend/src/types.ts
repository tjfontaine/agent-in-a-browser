/**
 * Shared Type Definitions
 * 
 * Centralized types used across the frontend application.
 */

// Re-export MCP types for convenience
export type { McpServerInfo, McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from './mcp-client';

/**
 * Messages sent from the sandbox worker to the main thread
 */
export interface SandboxMessage {
    type: 'status' | 'ready' | 'mcp-initialized' | 'tools' | 'tool_result' | 'console' | 'error' | 'mcp-response' | 'init_complete';
    message?: string;
    tools?: Array<{ name: string; description?: string }>;
    serverInfo?: { name: string; version: string };
    id?: string;
    result?: unknown;
    response?: {
        jsonrpc: string;
        id?: string | number;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
    };
}

/**
 * Messages sent from the main thread to the sandbox worker
 */
export interface SandboxRequest {
    type: 'init' | 'get_tools' | 'mcp-request';
    id?: string;
    request?: {
        jsonrpc: string;
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
    };
}

/**
 * Tool call result from sandbox
 */
export interface ToolCallResult {
    output?: string;
    error?: string;
    isError?: boolean;
}
