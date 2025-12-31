/**
 * MCP Module
 * 
 * Barrel export for MCP-related functionality.
 */

// Type definitions
export type {
    McpServerInfo,
    McpTool,
    McpToolResult,
    JsonRpcRequest,
    JsonRpcResponse,
} from './Client';

// Remote MCP Registry
export {
    RemoteMCPRegistry,
    getRemoteMCPRegistry,
    type RemoteMCPServer,
    type ServerConfig,
    type McpToolInfo,
} from './Registry';

// WASM Bridge
export { callWasmMcpServerFetch, initWasmBridge } from './WasmBridge';

