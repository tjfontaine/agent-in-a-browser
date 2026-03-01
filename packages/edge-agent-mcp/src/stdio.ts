/**
 * MCP stdio transport — reads JSON-RPC from stdin, writes to stdout.
 *
 * Follows the MCP stdio transport spec:
 * - Messages are newline-delimited JSON on stdin
 * - Responses are newline-delimited JSON on stdout
 * - Logs go to stderr
 */

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    id: string | number | null;
}

export type RequestHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

/**
 * Start reading JSON-RPC requests from stdin and dispatching them.
 * Responses are written to stdout. Returns when stdin closes.
 */
export function startStdioTransport(handler: RequestHandler): void {
    let buffer = '';
    const inflight = new Set<Promise<void>>();
    let stdinClosed = false;

    async function drainAndExit(): Promise<void> {
        if (inflight.size > 0) {
            await Promise.allSettled(inflight);
        }
        process.exit(0);
    }

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;

        // Process all complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);

            if (!line) continue;

            const p = processLine(line, handler);
            inflight.add(p);
            p.finally(() => {
                inflight.delete(p);
                if (stdinClosed && inflight.size === 0) {
                    drainAndExit();
                }
            });
        }
    });

    process.stdin.on('end', () => {
        log('stdin closed, shutting down');
        stdinClosed = true;
        if (inflight.size === 0) {
            drainAndExit();
        }
        // Otherwise drainAndExit will be called when the last request completes
    });
}

async function processLine(line: string, handler: RequestHandler): Promise<void> {
    let request: JsonRpcRequest;
    try {
        request = JSON.parse(line) as JsonRpcRequest;
    } catch {
        log(`Invalid JSON: ${line.slice(0, 100)}`);
        return;
    }

    try {
        const response = await handler(request);
        if (response) {
            writeResponse(response);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Handler error: ${message}`);
        if (request.id !== undefined && request.id !== null) {
            writeResponse({
                jsonrpc: '2.0',
                error: { code: -32603, message },
                id: request.id,
            });
        }
    }
}

/** Write a JSON-RPC response to stdout */
export function writeResponse(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
}

/** Write a log message to stderr (visible to the user, not the MCP client) */
export function log(message: string): void {
    process.stderr.write(`[edge-agent-mcp] ${message}\n`);
}
