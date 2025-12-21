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
    type: 'init_complete' | 'error';
    id?: string;
    message?: string;
}

/**
 * Messages sent from the main thread to the sandbox worker
 */
export interface SandboxRequest {
    type: 'init' | 'fetch';
    id?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

/**
 * Tool call result
 */
export interface ToolCallResult {
    output?: string;
    error?: string;
    isError?: boolean;
}

