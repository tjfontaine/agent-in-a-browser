/**
 * MCP Client for Web Worker
 * 
 * Implements the MCP (Model Context Protocol) client that communicates with the
 * WASM-based MCP server running in the worker.
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

/**
 * MCP Client for communicating with the WASM MCP server
 */
export class McpClient {
    private serverInfo: McpServerInfo | null = null;
    private tools: McpTool[] = [];
    private requestId = 0;

    constructor(
        private sendRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse>
    ) { }

    /**
     * Initialize the MCP connection
     */
    async initialize(): Promise<McpServerInfo> {
        const response = await this.sendRequest({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {}
                },
                clientInfo: {
                    name: 'web-agent-frontend',
                    version: '0.1.0'
                }
            }
        });

        if (response.error) {
            throw new Error(`MCP initialize error: ${response.error.message}`);
        }

        this.serverInfo = response.result.serverInfo;

        // Send initialized notification
        await this.sendRequest({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'initialized',
            params: {}
        });

        return this.serverInfo!;
    }

    /**
     * List available tools
     */
    async listTools(): Promise<McpTool[]> {
        const response = await this.sendRequest({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'tools/list',
            params: {}
        });

        if (response.error) {
            throw new Error(`MCP tools/list error: ${response.error.message}`);
        }

        this.tools = response.result.tools;
        return this.tools;
    }

    /**
     * Call a tool
     */
    async callTool(name: string, arguments_: Record<string, any>): Promise<McpToolResult> {
        const response = await this.sendRequest({
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'tools/call',
            params: {
                name,
                arguments: arguments_
            }
        });

        if (response.error) {
            throw new Error(`MCP tools/call error: ${response.error.message}`);
        }

        return response.result;
    }

    /**
     * Get server info
     */
    getServerInfo(): McpServerInfo | null {
        return this.serverInfo;
    }

    /**
     * Get available tools
     */
    getTools(): McpTool[] {
        return this.tools;
    }
}

/**
 * Create an MCP client that communicates via HTTP/fetch
 */
export function createHttpMcpClient(url: string): McpClient {
    const sendRequest = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    };

    return new McpClient(sendRequest);
}

/**
 * Create an MCP client that communicates via postMessage (for Web Workers)
 */
export function createWorkerMcpClient(
    postMessage: (message: any) => void,
    onMessage: (callback: (data: any) => void) => void
): McpClient {
    const pendingRequests = new Map<string | number, (response: JsonRpcResponse) => void>();

    // Setup message listener
    onMessage((data: any) => {
        if (data.type === 'mcp-response' && data.response) {
            const resolve = pendingRequests.get(data.response.id);
            if (resolve) {
                pendingRequests.delete(data.response.id);
                resolve(data.response);
            }
        }
    });

    const sendRequest = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
        return new Promise((resolve) => {
            pendingRequests.set(request.id, resolve);
            postMessage({
                type: 'mcp-request',
                request
            });
        });
    };

    return new McpClient(sendRequest);
}

/**
 * Create an MCP client that uses the WASM bridge directly
 */
export async function createWasmMcpClient(): Promise<McpClient> {
    // Dynamically import to avoid circular dependencies
    const { callWasmMcpServer } = await import('./wasm-mcp-bridge');
    return new McpClient(callWasmMcpServer);
}
