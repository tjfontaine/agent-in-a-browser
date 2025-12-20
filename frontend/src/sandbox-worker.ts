// Sandbox Worker with OPFS + MCP Tools
// All file operations use OPFS for consistency across views

export { }; // Make this a module

// We'll dynamically import esbuild-wasm from esm.sh at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esbuild: any = null;

// Extend FileSystemDirectoryHandle for entries() support
declare global {
    interface FileSystemDirectoryHandle {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }
}

// OPFS root handle
let opfsRoot: FileSystemDirectoryHandle | null = null;
let esbuildInitialized = false;

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

// ============ Shell with Coreutils ============

async function shell(command: string): Promise<string> {
    // Parse command - handle quotes and pipes (basic)
    const tokens = parseCommand(command);
    if (tokens.length === 0) return '';

    const cmd = tokens[0];
    const args = tokens.slice(1);

    try {
        switch (cmd) {
            case 'echo':
                return args.join(' ');

            case 'pwd':
                return '/';

            case 'date':
                return new Date().toISOString();

            case 'cat':
                return await shellCat(args);

            case 'ls':
                return await shellLs(args);

            case 'mkdir':
                return await shellMkdir(args);

            case 'rm':
                return await shellRm(args);

            case 'touch':
                return await shellTouch(args);

            case 'cp':
                return await shellCp(args);

            case 'mv':
                return await shellMv(args);

            case 'head':
                return await shellHead(args);

            case 'tail':
                return await shellTail(args);

            case 'wc':
                return await shellWc(args);

            case 'find':
                return await shellFind(args);

            case 'grep':
                return await shellGrep(args);

            case 'sort':
                return await shellSort(args);

            case 'uniq':
                return await shellUniq(args);

            case 'tee':
                return await shellTee(args);

            case 'which':
                return cmds.includes(args[0]) ? `/bin/${args[0]}` : `${args[0]} not found`;

            case 'help':
                return `Available commands: ${cmds.join(', ')}`;

            default:
                return `sh: ${cmd}: command not found. Type 'help' for available commands.`;
        }
    } catch (e: any) {
        return `${cmd}: ${e.message}`;
    }
}

const cmds = ['echo', 'pwd', 'date', 'cat', 'ls', 'mkdir', 'rm', 'touch', 'cp', 'mv', 'head', 'tail', 'wc', 'find', 'grep', 'sort', 'uniq', 'tee', 'which', 'help'];

function parseCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const char of command) {
        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = true;
            quoteChar = char;
        } else if (char === quoteChar && inQuote) {
            inQuote = false;
            quoteChar = '';
        } else if (char === ' ' && !inQuote) {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

async function shellCat(args: string[]): Promise<string> {
    if (args.length === 0) return 'cat: missing file operand';
    const results: string[] = [];
    for (const path of args) {
        const content = await readFile(path);
        results.push(content);
    }
    return results.join('\n');
}

async function shellLs(args: string[]): Promise<string> {
    const path = args.find(a => !a.startsWith('-')) || '/';
    const showLong = args.includes('-l') || args.includes('-la') || args.includes('-al');
    const showAll = args.includes('-a') || args.includes('-la') || args.includes('-al');

    const dir = await getDirHandle(path);
    const entries: string[] = [];

    if (showAll) {
        entries.push(showLong ? 'drwxr-xr-x  ./' : '.');
        entries.push(showLong ? 'drwxr-xr-x  ../' : '..');
    }

    for await (const [name, handle] of dir.entries()) {
        if (showLong) {
            const isDir = handle.kind === 'directory';
            const prefix = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
            let size = 0;
            if (!isDir) {
                const file = await (handle as FileSystemFileHandle).getFile();
                size = file.size;
            }
            entries.push(`${prefix}  ${size.toString().padStart(8)}  ${name}${isDir ? '/' : ''}`);
        } else {
            entries.push(handle.kind === 'directory' ? `${name}/` : name);
        }
    }

    return entries.length > 0 ? entries.join('\n') : '';
}

async function shellMkdir(args: string[]): Promise<string> {
    const createParents = args.includes('-p');
    const paths = args.filter(a => !a.startsWith('-'));

    if (paths.length === 0) return 'mkdir: missing operand';

    for (const path of paths) {
        await getDirHandle(path, true);
    }
    return '';
}

async function shellRm(args: string[]): Promise<string> {
    const recursive = args.includes('-r') || args.includes('-rf') || args.includes('-fr');
    const paths = args.filter(a => !a.startsWith('-'));

    if (paths.length === 0) return 'rm: missing operand';

    for (const path of paths) {
        const parts = path.split('/').filter(p => p);
        const name = parts.pop()!;
        const parentPath = '/' + parts.join('/');
        const parent = await getDirHandle(parentPath);
        await parent.removeEntry(name, { recursive });
    }
    return '';
}

async function shellTouch(args: string[]): Promise<string> {
    if (args.length === 0) return 'touch: missing file operand';

    for (const path of args) {
        try {
            await getFileHandle(path);
        } catch {
            await writeFile(path, '');
        }
    }
    return '';
}

async function shellCp(args: string[]): Promise<string> {
    const paths = args.filter(a => !a.startsWith('-'));
    if (paths.length < 2) return 'cp: missing destination file operand';

    const src = paths[0];
    const dest = paths[1];
    const content = await readFile(src);
    await writeFile(dest, content);
    return '';
}

async function shellMv(args: string[]): Promise<string> {
    const paths = args.filter(a => !a.startsWith('-'));
    if (paths.length < 2) return 'mv: missing destination file operand';

    const src = paths[0];
    const dest = paths[1];
    const content = await readFile(src);
    await writeFile(dest, content);

    // Remove source
    const parts = src.split('/').filter(p => p);
    const name = parts.pop()!;
    const parentPath = '/' + parts.join('/');
    const parent = await getDirHandle(parentPath);
    await parent.removeEntry(name);
    return '';
}

async function shellHead(args: string[]): Promise<string> {
    let n = 10;
    const nIdx = args.indexOf('-n');
    if (nIdx !== -1 && args[nIdx + 1]) {
        n = parseInt(args[nIdx + 1], 10);
    }
    const path = args.find(a => !a.startsWith('-') && !/^\d+$/.test(a));
    if (!path) return 'head: missing file operand';

    const content = await readFile(path);
    return content.split('\n').slice(0, n).join('\n');
}

async function shellTail(args: string[]): Promise<string> {
    let n = 10;
    const nIdx = args.indexOf('-n');
    if (nIdx !== -1 && args[nIdx + 1]) {
        n = parseInt(args[nIdx + 1], 10);
    }
    const path = args.find(a => !a.startsWith('-') && !/^\d+$/.test(a));
    if (!path) return 'tail: missing file operand';

    const content = await readFile(path);
    const lines = content.split('\n');
    return lines.slice(-n).join('\n');
}

async function shellWc(args: string[]): Promise<string> {
    const path = args.find(a => !a.startsWith('-'));
    if (!path) return 'wc: missing file operand';

    const content = await readFile(path);
    const lines = content.split('\n').length;
    const words = content.split(/\s+/).filter(w => w).length;
    const bytes = new TextEncoder().encode(content).length;

    return `  ${lines}   ${words}  ${bytes} ${path}`;
}

async function shellFind(args: string[]): Promise<string> {
    const startPath = args.find(a => !a.startsWith('-')) || '/';
    const namePattern = args.includes('-name') ? args[args.indexOf('-name') + 1] : null;

    const results: string[] = [];

    async function search(path: string, dir: FileSystemDirectoryHandle): Promise<void> {
        for await (const [name, handle] of dir.entries()) {
            const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;

            if (!namePattern || matchGlob(name, namePattern)) {
                results.push(fullPath);
            }

            if (handle.kind === 'directory') {
                await search(fullPath, handle as FileSystemDirectoryHandle);
            }
        }
    }

    const dir = await getDirHandle(startPath);
    await search(startPath, dir);
    return results.join('\n');
}

function matchGlob(name: string, pattern: string): boolean {
    const regex = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(name);
}

async function shellGrep(args: string[]): Promise<string> {
    const ignoreCase = args.includes('-i');
    const showLineNums = args.includes('-n');
    const invertMatch = args.includes('-v');
    const remaining = args.filter(a => !a.startsWith('-'));

    if (remaining.length < 2) return 'grep: missing pattern or file';

    const pattern = remaining[0];
    const files = remaining.slice(1);
    const regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    const results: string[] = [];

    for (const file of files) {
        try {
            const content = await readFile(file);
            const lines = content.split('\n');

            lines.forEach((line, idx) => {
                const matches = regex.test(line);
                regex.lastIndex = 0;

                if (matches !== invertMatch) {
                    const prefix = files.length > 1 ? `${file}:` : '';
                    const lineNum = showLineNums ? `${idx + 1}:` : '';
                    results.push(`${prefix}${lineNum}${line}`);
                }
            });
        } catch (e) {
            results.push(`grep: ${file}: No such file`);
        }
    }

    return results.join('\n');
}

async function shellSort(args: string[]): Promise<string> {
    const reverse = args.includes('-r');
    const numeric = args.includes('-n');
    const path = args.find(a => !a.startsWith('-'));

    if (!path) return 'sort: missing file operand';

    const content = await readFile(path);
    let lines = content.split('\n');

    if (numeric) {
        lines.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
        lines.sort();
    }

    if (reverse) lines.reverse();
    return lines.join('\n');
}

async function shellUniq(args: string[]): Promise<string> {
    const count = args.includes('-c');
    const path = args.find(a => !a.startsWith('-'));

    if (!path) return 'uniq: missing file operand';

    const content = await readFile(path);
    const lines = content.split('\n');
    const results: string[] = [];

    let prevLine = '';
    let lineCount = 0;

    for (const line of lines) {
        if (line === prevLine) {
            lineCount++;
        } else {
            if (prevLine !== '' || lineCount > 0) {
                results.push(count ? `${lineCount.toString().padStart(7)} ${prevLine}` : prevLine);
            }
            prevLine = line;
            lineCount = 1;
        }
    }
    if (prevLine !== '' || lineCount > 0) {
        results.push(count ? `${lineCount.toString().padStart(7)} ${prevLine}` : prevLine);
    }

    return results.join('\n');
}

async function shellTee(args: string[]): Promise<string> {
    // Read from stdin (simulated - just return empty for now)
    // In real usage, would need piping support
    const path = args.find(a => !a.startsWith('-'));
    if (!path) return 'tee: missing file operand';

    return `tee: piping not yet supported. Use write_file tool instead.`;
}

// ============ TypeScript Execution ============

async function initEsbuild(): Promise<void> {
    if (esbuildInitialized) return;

    try {
        // Dynamically import esbuild-wasm from esm.sh
        const esbuildModule = await import(/* @vite-ignore */ 'https://esm.sh/esbuild-wasm@0.20.0');
        esbuild = esbuildModule.default || esbuildModule;

        // Initialize with wasmURL
        await esbuild.initialize({
            wasmURL: 'https://unpkg.com/esbuild-wasm@0.20.0/esbuild.wasm'
        });

        esbuildInitialized = true;
    } catch (e: any) {
        throw new Error(`Failed to initialize esbuild: ${e.message}`);
    }
}

async function executeTypeScript(code: string): Promise<string> {
    await initEsbuild();

    // Transform npm imports to esm.sh URLs
    const transformedCode = transformImports(code);

    // Compile TypeScript to JavaScript
    const result = await esbuild.transform(transformedCode, {
        loader: 'tsx',
        format: 'esm',
        target: 'es2022',
    });

    // Extract imports from compiled code (they must be at top level)
    const importRegex = /^import\s+.+;?\s*$/gm;
    const imports: string[] = [];
    const codeWithoutImports = result.code.replace(importRegex, (match: string) => {
        imports.push(match);
        return '';
    });

    // Create ESM module with imports at top, execution in async IIFE
    const wrappedCode = `
// ===== Node.js fs/path Shims for Sandbox (using OPFS via globalThis) =====
const fs = {
    promises: {
        readFile: async (p, options) => {
            if (typeof globalThis.__opfs?.readFile === 'function') {
                return globalThis.__opfs.readFile(p);
            }
            throw new Error('fs.readFile not available');
        },
        writeFile: async (p, data, options) => {
            if (typeof globalThis.__opfs?.writeFile === 'function') {
                const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
                return globalThis.__opfs.writeFile(p, content);
            }
            throw new Error('fs.writeFile not available');
        },
        readdir: async (p, options) => {
            if (typeof globalThis.__opfs?.readdir === 'function') {
                return globalThis.__opfs.readdir(p);
            }
            throw new Error('fs.readdir not available');
        },
        mkdir: async (p, options) => {
            if (typeof globalThis.__opfs?.mkdir === 'function') {
                return globalThis.__opfs.mkdir(p);
            }
            throw new Error('fs.mkdir not available');
        },
        rm: async (p, options) => {
            if (typeof globalThis.__opfs?.rm === 'function') {
                return globalThis.__opfs.rm(p, options?.recursive || false);
            }
            throw new Error('fs.rm not available');
        },
        stat: async (p) => {
            if (typeof globalThis.__opfs?.stat === 'function') {
                return globalThis.__opfs.stat(p);
            }
            throw new Error('fs.stat not available');
        },
        access: async (p) => {
            if (typeof globalThis.__opfs?.exists === 'function') {
                const exists = await globalThis.__opfs.exists(p);
                if (!exists) throw new Error('ENOENT: no such file or directory');
            }
        },
    },
    readFileSync: (p) => { throw new Error('Sync fs not available. Use fs.promises.readFile.'); },
    writeFileSync: (p, d) => { throw new Error('Sync fs not available. Use fs.promises.writeFile.'); },
    existsSync: (p) => {
        console.warn('fs.existsSync is not reliable in sandbox, use fs.promises.access instead');
        return false;
    },
};

const path = {
    join: (...p) => p.filter(Boolean).join('/').replace(/\\/\\/+/g, '/'),
    resolve: (...p) => '/' + p.filter(Boolean).join('/').replace(/\\/\\/+/g, '/').replace(/^\\/+/, ''),
    dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    basename: (p, ext) => { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: (p) => { const b = p.split('/').pop() || ''; const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
    sep: '/',
    delimiter: ':',
    isAbsolute: (p) => p.startsWith('/'),
    normalize: (p) => p.replace(/\\/\\/+/g, '/'),
};

// ===== Network fetch shim (proxied through worker) =====
const fetch = async (url, options) => {
    if (typeof globalThis.__opfs?.fetch === 'function') {
        return globalThis.__opfs.fetch(url, options);
    }
    throw new Error('fetch not available in sandbox');
};

// ===== External imports =====
${imports.join('\n')}

// ===== Execution environment =====
const __logs = [];
const console = {
    log: (...args) => __logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
    error: (...args) => __logs.push('ERROR: ' + args.map(a => String(a)).join(' ')),
    warn: (...args) => __logs.push('WARN: ' + args.map(a => String(a)).join(' ')),
    info: (...args) => __logs.push('INFO: ' + args.map(a => String(a)).join(' ')),
};

// Wrap user code in async IIFE so top-level await works
const __run = async () => {
    try {
        ${codeWithoutImports}
    } catch (e) {
        __logs.push('Error: ' + e.message);
    }
};

// Execute and wait for completion before exporting logs
await __run();

export { __logs };
    `;

    // Expose OPFS functions on globalThis so blob URL module can access them
    // These functions include console.log for easier debugging in browser DevTools
    (globalThis as any).__opfs = {
        readFile: async (p: string) => {
            console.log('[OPFS] readFile:', p);
            const content = await readFile(p);
            console.log('[OPFS] readFile result:', content.length, 'chars');
            return content;
        },
        writeFile: async (p: string, content: string) => {
            console.log('[OPFS] writeFile:', p, `(${content.length} chars)`);
            const bytes = await writeFile(p, content);
            console.log('[OPFS] writeFile done:', bytes, 'bytes');
            return bytes;
        },
        readdir: async (p: string) => {
            console.log('[OPFS] readdir:', p);
            const result = await listDir(p);
            console.log('[OPFS] readdir result:', result);
            return result;
        },
        mkdir: async (p: string) => {
            console.log('[OPFS] mkdir:', p);
            await getDirHandle(p, true);
            console.log('[OPFS] mkdir done');
        },
        rm: async (p: string, recursive: boolean) => {
            console.log('[OPFS] rm:', p, { recursive });
            const parts = p.split('/').filter((x: string) => x);
            const name = parts.pop()!;
            const parentPath = '/' + parts.join('/');
            const parent = await getDirHandle(parentPath);
            await parent.removeEntry(name, { recursive });
            console.log('[OPFS] rm done');
        },
        exists: async (p: string) => {
            console.log('[OPFS] exists:', p);
            try {
                await getFileHandle(p);
                console.log('[OPFS] exists: true (file)');
                return true;
            } catch {
                try {
                    await getDirHandle(p);
                    console.log('[OPFS] exists: true (dir)');
                    return true;
                } catch {
                    console.log('[OPFS] exists: false');
                    return false;
                }
            }
        },
        stat: async (p: string) => {
            console.log('[OPFS] stat:', p);
            try {
                const file = await getFileHandle(p);
                const f = await file.getFile();
                const result = { size: f.size, isFile: () => true, isDirectory: () => false };
                console.log('[OPFS] stat result:', result);
                return result;
            } catch {
                await getDirHandle(p);
                const result = { size: 0, isFile: () => false, isDirectory: () => true };
                console.log('[OPFS] stat result:', result);
                return result;
            }
        },
        // Network fetch - proxied through the worker
        fetch: async (url: string, options?: RequestInit) => {
            console.log('[SANDBOX] fetch:', url, options?.method || 'GET');
            try {
                const response = await fetch(url, options);
                const text = await response.text();
                console.log('[SANDBOX] fetch response:', response.status, text.length, 'chars');
                // Return an object that mimics Response but with already-resolved body
                return {
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()),
                    text: async () => text,
                    json: async () => JSON.parse(text),
                };
            } catch (e: any) {
                console.error('[SANDBOX] fetch error:', e.message);
                throw e;
            }
        },
    };

    const blob = new Blob([wrappedCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    try {
        const module = await import(/* @vite-ignore */ url);
        URL.revokeObjectURL(url);

        // Clean up globalThis.__opfs
        delete (globalThis as any).__opfs;

        const logs = module.__logs || [];
        return logs.join('\n') || '(no output)';
    } catch (e: any) {
        URL.revokeObjectURL(url);
        delete (globalThis as any).__opfs;
        throw new Error(`Execution error: ${e.message}`);
    }
}

function transformImports(code: string): string {
    // Skip Node.js built-in imports (we provide shims)
    const nodeBuiltins = ['fs', 'path', 'node:fs', 'node:path', 'fs/promises', 'node:fs/promises'];

    // First, remove Node.js built-in imports entirely (we inject shims)
    let transformed = code.replace(
        /import\s+.*?\s+from\s+['"](?:node:)?(?:fs|path)(?:\/promises)?['"];?\s*\n?/g,
        ''
    );

    // Transform bare npm imports to esm.sh URLs
    transformed = transformed.replace(
        /from\s+['"]([^'"./][^'"]*)['"]/g,
        (match, pkg) => {
            // Don't transform URLs
            if (pkg.startsWith('http') || pkg.startsWith('https')) {
                return match;
            }
            // Don't transform Node.js builtins
            if (nodeBuiltins.includes(pkg)) {
                return match;
            }
            return `from 'https://esm.sh/${pkg}'`;
        }
    ).replace(
        /import\s+['"]([^'"./][^'"]*)['"]/g,
        (match, pkg) => {
            if (pkg.startsWith('http') || pkg.startsWith('https')) {
                return match;
            }
            if (nodeBuiltins.includes(pkg)) {
                return match;
            }
            return `import 'https://esm.sh/${pkg}'`;
        }
    );

    return transformed;
}

// Simple JS execution (for backward compatibility)
function executeJs(code: string): string {
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
                output = await shell(tool.input.command as string);
                break;

            case 'execute':
                output = executeJs(tool.input.code as string);
                break;

            case 'execute_typescript':
                output = await executeTypeScript(tool.input.code as string);
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
                    description: 'Run shell commands. Available: cat, ls, mkdir, rm, touch, cp, mv, head, tail, wc, find, grep, sort, uniq, echo, pwd, date. Supports flags like -l, -r, -n.',
                    input_schema: {
                        type: 'object',
                        properties: { command: { type: 'string', description: 'Shell command with arguments' } },
                        required: ['command']
                    }
                },
                {
                    name: 'execute',
                    description: 'Execute simple JavaScript expression',
                    input_schema: {
                        type: 'object',
                        properties: { code: { type: 'string', description: 'JavaScript expression to evaluate' } },
                        required: ['code']
                    }
                },
                {
                    name: 'execute_typescript',
                    description: 'Execute TypeScript code with npm package support. Use import statements for packages (e.g., import lodash from "lodash"). Packages are loaded from esm.sh CDN. Use console.log() for output.',
                    input_schema: {
                        type: 'object',
                        properties: {
                            code: {
                                type: 'string',
                                description: 'TypeScript code to execute. Can include npm imports like: import lodash from "lodash"'
                            }
                        },
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
