/**
 * MCP Client for Browser - wraps the WASM MCP server
 * 
 * Uses a single-request pattern: prepopulate stdin, run server once, collect stdout.
 * This avoids the blocking I/O problem in browsers.
 */

// Buffers for stdin/stdout communication
let stdinBuffer: string[] = [];
let stdoutLines: string[] = [];
let serverRunning = false;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Handler types for WASI streams
interface InputStreamHandler {
    blockingRead(len: number): Uint8Array;
    subscribe(): void;
    [Symbol.dispose](): void;
}

interface OutputStreamHandler {
    write(contents: Uint8Array): void;
    blockingFlush(): void;
    [Symbol.dispose](): void;
}

// Custom stdin handler - reads from our buffer
// IMPORTANT: Must never return null - return empty Uint8Array if no data
const stdinHandler: InputStreamHandler = {
    blockingRead(_len: number): Uint8Array {
        if (stdinBuffer.length > 0) {
            const line = stdinBuffer.shift()!;
            return textEncoder.encode(line + '\n');
        }
        // Return empty array to signal EOF / no data
        // This will cause the server's stdin.lines() to end
        return new Uint8Array(0);
    },

    subscribe() { },
    [Symbol.dispose]() { }
};

// Custom stdout handler - captures output
const stdoutHandler: OutputStreamHandler = {
    write(contents: Uint8Array) {
        const text = textDecoder.decode(contents);
        // Collect complete lines
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                stdoutLines.push(line);
            }
        }
        console.log('[MCP stdout]:', text);
    },

    blockingFlush() { },
    [Symbol.dispose]() { }
};

// Custom stderr handler
const stderrHandler: OutputStreamHandler = {
    write(contents: Uint8Array) {
        console.error('[MCP stderr]:', textDecoder.decode(contents));
    },
    blockingFlush() { },
    [Symbol.dispose]() { }
};

/**
 * Configure the preview2-shim with our custom handlers
 */
async function configurePreview2Shim(): Promise<void> {
    const cli = await import('@bytecodealliance/preview2-shim/cli') as unknown as {
        _setStdin: (handler: InputStreamHandler) => void;
        _setStdout: (handler: OutputStreamHandler) => void;
        _setStderr: (handler: OutputStreamHandler) => void;
    };

    cli._setStdin(stdinHandler);
    cli._setStdout(stdoutHandler);
    cli._setStderr(stderrHandler);
}

// Store the imported module
let mcpModule: { run: { run: () => void | Promise<void> } } | null = null;

/**
 * Send a single JSON-RPC request and get response
 * This runs the WASM server once per request
 */
async function sendSingleRequest<T>(request: object): Promise<T> {
    if (!mcpModule) {
        throw new Error('MCP module not loaded');
    }

    // Clear state
    stdinBuffer = [JSON.stringify(request)];
    stdoutLines = [];

    // Run the server - it will read stdin (our request), 
    // write stdout (response), then exit when stdin is empty
    try {
        await Promise.resolve(mcpModule.run.run());
    } catch (e) {
        // ComponentExit is expected
        if (!(e as { exitError?: boolean }).exitError) {
            throw e;
        }
    }

    // Parse the response
    if (stdoutLines.length === 0) {
        throw new Error('No response from MCP server');
    }

    const response = JSON.parse(stdoutLines[0]);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.result;
}

/**
 * MCP Client interface
 */
export interface McpClient {
    initialize(): Promise<InitializeResult>;
    listTools(): Promise<Tool[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface InitializeResult {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
}

export interface Tool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface ToolResult {
    content: { type: string; text: string }[];
    isError?: boolean;
}

let nextRequestId = 1;

function createRequest(method: string, params: Record<string, unknown> = {}) {
    return {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method,
        params
    };
}

/**
 * Create an MCP client
 */
export function createMcpClient(): McpClient {
    return {
        async initialize(): Promise<InitializeResult> {
            return sendSingleRequest(createRequest('initialize', {
                protocolVersion: '2024-11-05',
                clientInfo: { name: 'browser-mcp-client', version: '0.1.0' }
            }));
        },

        async listTools(): Promise<Tool[]> {
            const result = await sendSingleRequest<{ tools: Tool[] }>(createRequest('tools/list', {}));
            return result.tools;
        },

        async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
            return sendSingleRequest(createRequest('tools/call', { name, arguments: args }));
        }
    };
}

/**
 * Initialize and return the MCP client
 */
export async function initMcpServer(): Promise<McpClient> {
    // Configure preview2-shim first
    await configurePreview2Shim();

    // Import the JCO-generated module
    mcpModule = await import('./mcp-server/ts_runtime_mcp.js') as unknown as {
        run: { run: () => void | Promise<void> };
    };

    return createMcpClient();
}

export default { createMcpClient, initMcpServer };
