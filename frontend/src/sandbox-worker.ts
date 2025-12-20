// Sandbox Worker with OPFS + MCP Tools
// All file operations use OPFS for consistency across views

export { }; // Make this a module

// Extend FileSystemDirectoryHandle for entries() support
declare global {
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }
}

// OPFS root handle
let opfsRoot: FileSystemDirectoryHandle | null = null;

// ============ OPFS Helpers ============

async function initOPFS(): Promise<void> {
    opfsRoot = await navigator.storage.getDirectory();
}

async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p);
    let current: FileSystemDirectoryHandle = opfsRoot;

    // Navigate to parent directory
    for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i], { create });
    }

    // Get file handle
    return await current.getFileHandle(parts[parts.length - 1], { create });
}

async function getDirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    if (!path || path === '/') return opfsRoot;

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
    const newContent = content.replace(oldText, newText);
    await writeFile(path, newContent);
    return newContent;
}

async function listDir(path: string = '/'): Promise<string[]> {
    const dir = await getDirHandle(path);
    const entries: string[] = [];

    for await (const [name, handle] of dir.entries()) {
        const prefix = handle.kind === 'directory' ? '📁 ' : '📄 ';
        entries.push(prefix + name);
    }

    return entries;
}

async function grep(pattern: string, path: string = '/'): Promise<{ file: string; line: number; text: string }[]> {
    const results: { file: string; line: number; text: string }[] = [];
    const regex = new RegExp(pattern, 'gi');

    async function searchDir(dirPath: string, dir: FileSystemDirectoryHandle): Promise<void> {
        for await (const [name, handle] of dir.entries()) {
            const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;

            if (handle.kind === 'file') {
                try {
                    const file = await (handle as FileSystemFileHandle).getFile();
                    const content = await file.text();
                    const lines = content.split('\n');

                    lines.forEach((line, idx) => {
                        if (regex.test(line)) {
                            results.push({ file: fullPath, line: idx + 1, text: line.trim() });
                        }
                        regex.lastIndex = 0; // Reset regex state
                    });
                } catch (e) {
                    // Skip binary files
                }
            } else {
                await searchDir(fullPath, handle as FileSystemDirectoryHandle);
            }
        }
    }

    const startDir = await getDirHandle(path);
    await searchDir(path, startDir);
    return results;
}

function shell(command: string): string {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
        case 'echo':
            return args.join(' ');
        case 'pwd':
            return '/';
        case 'date':
            return new Date().toISOString();
        default:
            return `Unknown command: ${cmd}. Available: echo, pwd, date. Use read_file/write_file for file ops.`;
    }
}

function executeJs(code: string): string {
    // Use simple Function() for now - isolated but not sandboxed
    // In production, would use QuickJS or similar
    try {
        const fn = new Function('return (' + code + ')');
        const result = fn();
        return String(result);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
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

        switch (tool.name) {
            case 'read_file':
                output = await readFile(tool.input.path as string);
                break;

            case 'write_file':
                await writeFile(tool.input.path as string, tool.input.content as string);
                output = `Wrote ${(tool.input.content as string).length} bytes to ${tool.input.path}`;
                break;

            case 'edit_file':
                output = await editFile(
                    tool.input.path as string,
                    tool.input.old_text as string,
                    tool.input.new_text as string
                );
                break;

            case 'list':
                const entries = await listDir(tool.input.path as string || '/');
                output = entries.join('\n') || '(empty directory)';
                break;

            case 'grep':
                const matches = await grep(tool.input.pattern as string, tool.input.path as string);
                output = matches.length > 0
                    ? matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
                    : 'No matches found';
                break;

            case 'shell':
                output = shell(tool.input.command as string);
                break;

            case 'execute':
                output = executeJs(tool.input.code as string);
                break;

            default:
                throw new Error(`Unknown tool: ${tool.name}`);
        }

        return { success: true, output };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

// ============ Worker Init ============

async function initialize(): Promise<void> {
    self.postMessage({ type: 'status', message: 'Initializing OPFS...' });
    await initOPFS();

    self.postMessage({ type: 'ready' });
}

// ============ Message Handler ============

self.onmessage = async (event: MessageEvent) => {
    const { type, id, tool } = event.data;

    if (type === 'call_tool') {
        const result = await callTool(tool);
        self.postMessage({ type: 'tool_result', id, result });
    } else if (type === 'get_tools') {
        // Return MCP tool definitions
        self.postMessage({
            type: 'tools',
            tools: [
                {
                    name: 'read_file',
                    description: 'Read contents of a file',
                    input_schema: {
                        type: 'object',
                        properties: { path: { type: 'string', description: 'File path' } },
                        required: ['path']
                    }
                },
                {
                    name: 'write_file',
                    description: 'Write content to a file (creates if not exists)',
                    input_schema: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path' },
                            content: { type: 'string', description: 'File content' }
                        },
                        required: ['path', 'content']
                    }
                },
                {
                    name: 'edit_file',
                    description: 'Find and replace text in a file',
                    input_schema: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path' },
                            old_text: { type: 'string', description: 'Text to find' },
                            new_text: { type: 'string', description: 'Text to replace with' }
                        },
                        required: ['path', 'old_text', 'new_text']
                    }
                },
                {
                    name: 'list',
                    description: 'List files and directories',
                    input_schema: {
                        type: 'object',
                        properties: { path: { type: 'string', description: 'Directory path (default: /)' } },
                        required: []
                    }
                },
                {
                    name: 'grep',
                    description: 'Search for pattern in files',
                    input_schema: {
                        type: 'object',
                        properties: {
                            pattern: { type: 'string', description: 'Search pattern (regex)' },
                            path: { type: 'string', description: 'Directory to search (default: /)' }
                        },
                        required: ['pattern']
                    }
                },
                {
                    name: 'shell',
                    description: 'Run shell command (echo, pwd, date)',
                    input_schema: {
                        type: 'object',
                        properties: { command: { type: 'string', description: 'Shell command' } },
                        required: ['command']
                    }
                },
                {
                    name: 'execute',
                    description: 'Execute JavaScript code',
                    input_schema: {
                        type: 'object',
                        properties: { code: { type: 'string', description: 'JavaScript expression to evaluate' } },
                        required: ['code']
                    }
                }
            ]
        });
    }
};

// Start
initialize().catch(err => {
    self.postMessage({ type: 'error', message: err.message });
});
