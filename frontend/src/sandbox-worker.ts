// Sandbox Worker with OPFS + MCP Tools
// Uses the new Rust-based TsRuntime (QuickJS-NG + SWC) for TypeScript execution
// Integrates with WASM MCP server for tool calls

export { }; // Make this a module

import { initTsRuntime, TsRuntime } from './wasm/ts-runtime';
import { createWasmMcpClient, McpClient, JsonRpcRequest, JsonRpcResponse } from './mcp-client';

// Runtime instance
let tsRuntime: TsRuntime | null = null;

// MCP Client
let mcpClient: McpClient | null = null;

// OPFS root handle
let opfsRoot: FileSystemDirectoryHandle | null = null;

// Captured logs from execution
let capturedLogs: string[] = [];

// Pending MCP requests (for postMessage bridge)
const pendingMcpRequests = new Map<string | number, (response: JsonRpcResponse) => void>();

// Extend FileSystemDirectoryHandle for entries() support
declare global {
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }
}

// ============ Initialization ============

async function initialize(): Promise<void> {
    console.log('[Sandbox] Initializing...');

    // Initialize OPFS
    opfsRoot = await navigator.storage.getDirectory();
    console.log('[Sandbox] OPFS initialized');

    // Initialize TsRuntime
    tsRuntime = await initTsRuntime();
    console.log('[Sandbox] TsRuntime initialized');

    // Initialize MCP Client - using direct WASM bridge
    // The WASM component is loaded and executed in-process via the bridge
    mcpClient = await createWasmMcpClient();

    try {
        const serverInfo = await mcpClient.initialize();
        console.log('[Sandbox] MCP initialized:', serverInfo);

        const tools = await mcpClient.listTools();
        console.log('[Sandbox] MCP tools:', tools);

        // Send tools list to main thread
        self.postMessage({
            type: 'mcp-initialized',
            serverInfo,
            tools
        });
    } catch (error) {
        console.error('[Sandbox] MCP initialization failed:', error);
        // Continue without MCP - graceful degradation
    }
}

// ============ OPFS Helpers ============

async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p);
    let current: FileSystemDirectoryHandle = opfsRoot;

    for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i], { create });
    }

    return await current.getFileHandle(parts[parts.length - 1], { create });
}

async function getDirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    if (path === '/' || path === '') return opfsRoot;

    const parts = path.split('/').filter(p => p);
    let current: FileSystemDirectoryHandle = opfsRoot;

    for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create });
    }

    return current;
}

// ============ MCP Tools ============

async function readFile(path: string): Promise<string> {
    const handle = await getFileHandle(path);
    const file = await handle.getFile();
    return await file.text();
}

async function writeFile(path: string, content: string): Promise<void> {
    const handle = await getFileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
}

async function editFile(path: string, oldText: string, newText: string): Promise<string> {
    const content = await readFile(path);
    if (!content.includes(oldText)) {
        throw new Error(`Text not found in file: ${oldText.substring(0, 50)}...`);
    }
    const updated = content.replace(oldText, newText);
    await writeFile(path, updated);
    return 'File updated successfully';
}

async function listDir(path: string = '/'): Promise<string[]> {
    const handle = await getDirHandle(path);
    const entries: string[] = [];
    for await (const [name, entry] of handle.entries()) {
        entries.push(entry.kind === 'directory' ? `${name}/` : name);
    }
    return entries.sort();
}

async function grep(pattern: string, path: string = '/'): Promise<{ file: string; line: number; text: string }[]> {
    const results: { file: string; line: number; text: string }[] = [];
    const regex = new RegExp(pattern, 'gi');

    async function searchDir(dirPath: string, dir: FileSystemDirectoryHandle): Promise<void> {
        for await (const [name, entry] of dir.entries()) {
            const fullPath = `${dirPath}/${name}`;
            if (entry.kind === 'directory') {
                await searchDir(fullPath, await dir.getDirectoryHandle(name));
            } else {
                try {
                    const file = await (entry as FileSystemFileHandle).getFile();
                    const text = await file.text();
                    const lines = text.split('\n');
                    lines.forEach((lineText, idx) => {
                        if (regex.test(lineText)) {
                            results.push({ file: fullPath, line: idx + 1, text: lineText.trim() });
                        }
                    });
                } catch {
                    // Skip binary files
                }
            }
        }
    }

    await searchDir(path, await getDirHandle(path));
    return results;
}

// ============ Shell Commands ============

const SHELL_COMMANDS = ['echo', 'pwd', 'date', 'cat', 'ls', 'mkdir', 'rm', 'touch', 'cp', 'mv',
    'head', 'tail', 'wc', 'find', 'grep', 'tsc', 'node', 'tsx', 'npx', 'help'];

function parseCommand(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote = '';

    for (const char of command) {
        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = char;
        } else if (char === inQuote) {
            inQuote = '';
        } else if (char === ' ' && !inQuote) {
            if (current) { args.push(current); current = ''; }
        } else {
            current += char;
        }
    }
    if (current) args.push(current);
    return args;
}

async function shell(command: string): Promise<string> {
    const args = parseCommand(command);
    if (args.length === 0) return '';

    const cmd = args[0];
    const rest = args.slice(1);

    switch (cmd) {
        case 'echo': return rest.join(' ');
        case 'pwd': return '/';
        case 'date': return new Date().toISOString();
        case 'cat': return rest.length ? await readFile(rest[0]) : 'Usage: cat <file>';
        case 'ls': return (await listDir(rest[0] || '/')).join('\n');
        case 'mkdir':
            await getDirHandle(rest[0], true);
            return '';
        case 'touch':
            await writeFile(rest[0], '');
            return '';
        case 'head': {
            const n = rest.includes('-n') ? parseInt(rest[rest.indexOf('-n') + 1]) : 10;
            const file = rest.filter(a => !a.startsWith('-'))[0];
            const content = await readFile(file);
            return content.split('\n').slice(0, n).join('\n');
        }
        case 'tail': {
            const n = rest.includes('-n') ? parseInt(rest[rest.indexOf('-n') + 1]) : 10;
            const file = rest.filter(a => !a.startsWith('-'))[0];
            const content = await readFile(file);
            return content.split('\n').slice(-n).join('\n');
        }
        case 'wc': {
            const content = await readFile(rest[0]);
            const lines = content.split('\n').length;
            const words = content.split(/\s+/).filter(w => w).length;
            const chars = content.length;
            return `${lines} ${words} ${chars} ${rest[0]}`;
        }
        case 'find': {
            const results: string[] = [];
            const search = async (path: string, dir: FileSystemDirectoryHandle): Promise<void> => {
                for await (const [name, entry] of dir.entries()) {
                    const fullPath = `${path}/${name}`;
                    results.push(fullPath);
                    if (entry.kind === 'directory') {
                        await search(fullPath, await dir.getDirectoryHandle(name));
                    }
                }
            };
            await search(rest[0] || '', await getDirHandle(rest[0] || '/'));
            return results.join('\n');
        }
        case 'grep': {
            const matches = await grep(rest[0], rest[1] || '/');
            return matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
        }
        case 'tsc':
        case 'node':
        case 'tsx':
        case 'npx': {
            // Execute TypeScript/JavaScript
            const file = rest[0];
            if (!file) return `Usage: ${cmd} <file>`;
            const code = await readFile(file);
            return await executeTypeScript(code);
        }
        case 'help':
            return `Available commands: ${SHELL_COMMANDS.join(', ')}`;
        default:
            return `Unknown command: ${cmd}. Type 'help' for available commands.`;
    }
}

// ============ TypeScript Execution ============

async function executeTypeScript(code: string): Promise<string> {
    if (!tsRuntime) {
        throw new Error('TsRuntime not initialized');
    }

    capturedLogs = [];

    try {
        const result = await tsRuntime.eval(code);

        // If there are captured logs, include them
        if (capturedLogs.length > 0) {
            return capturedLogs.join('\n');
        }

        return result || '(no output)';
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

async function executeJs(code: string): Promise<string> {
    return executeTypeScript(code);
}

// ============ Tool Dispatcher ============

interface ToolCall {
    name: string;
    input: Record<string, unknown>;
}

interface ToolResult {
    success: boolean;
    output?: string;
    error?: string;
}

async function callTool(tool: ToolCall): Promise<ToolResult> {
    try {
        let output: string;
        const input = tool.input;

        switch (tool.name) {
            case 'read_file':
                output = await readFile(input.path as string);
                break;
            case 'write_file':
                await writeFile(input.path as string, input.content as string);
                output = 'File written successfully';
                break;
            case 'edit_file':
                output = await editFile(
                    input.path as string,
                    input.old_text as string,
                    input.new_text as string
                );
                break;
            case 'list_dir':
                output = (await listDir(input.path as string)).join('\n');
                break;
            case 'grep':
                const matches = await grep(input.pattern as string, input.path as string);
                output = matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
                break;
            case 'shell':
                output = await shell(input.command as string);
                break;
            case 'execute_js':
                output = await executeJs(input.code as string);
                break;
            case 'execute_typescript':
                output = await executeTypeScript(input.code as string);
                break;
            default:
                return { success: false, error: `Unknown tool: ${tool.name}` };
        }

        return { success: true, output };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ============ Message Handler ============

self.onmessage = async (event: MessageEvent) => {
    const { type, id, ...data } = event.data;

    try {
        switch (type) {
            case 'init':
                await initialize();
                self.postMessage({ type: 'init_complete', id });
                break;

            case 'mcp-request':
                // Forward MCP requests to the WASM MCP server
                if (!mcpClient) {
                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response: {
                            jsonrpc: '2.0',
                            id: data.request.id,
                            error: {
                                code: -32000,
                                message: 'MCP client not initialized'
                            }
                        }
                    });
                    break;
                }

                try {
                    const request = data.request as JsonRpcRequest;
                    let response: JsonRpcResponse;

                    // Route to appropriate MCP method
                    switch (request.method) {
                        case 'tools/call': {
                            const result = await mcpClient.callTool(
                                request.params?.name || '',
                                request.params?.arguments || {}
                            );
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                result
                            };
                            break;
                        }
                        case 'tools/list': {
                            const tools = await mcpClient.listTools();
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                result: { tools }
                            };
                            break;
                        }
                        default:
                            response = {
                                jsonrpc: '2.0',
                                id: request.id,
                                error: {
                                    code: -32601,
                                    message: `Method not found: ${request.method}`
                                }
                            };
                    }

                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response
                    });
                } catch (error: any) {
                    self.postMessage({
                        type: 'mcp-response',
                        id,
                        response: {
                            jsonrpc: '2.0',
                            id: data.request.id,
                            error: {
                                code: -32000,
                                message: error.message
                            }
                        }
                    });
                }
                break;

                self.postMessage({ type: 'write_complete', id });
                break;

            case 'list_dir':
                const entries = await listDir(data.path);
                self.postMessage({ type: 'dir_list', id, entries });
                break;

            case 'shell':
                const shellOutput = await shell(data.command);
                self.postMessage({ type: 'shell_result', id, output: shellOutput });
                break;

            case 'execute':
                const execOutput = await executeTypeScript(data.code);
                self.postMessage({ type: 'exec_result', id, output: execOutput });
                break;

            default:
                self.postMessage({ type: 'error', id, message: `Unknown message type: ${type}` });
        }
    } catch (e: any) {
        self.postMessage({ type: 'error', id, message: e.message });
    }
};

// Start
initialize().catch(err => {
    self.postMessage({ type: 'error', message: `Init failed: ${err.message}` });
});
