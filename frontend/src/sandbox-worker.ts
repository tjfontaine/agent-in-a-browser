// Sandbox Worker with OPFS + MCP Tools
// All file operations use OPFS for consistency across views
// Uses QuickJS for sandboxed JavaScript execution

export { }; // Make this a module

import { newQuickJSAsyncWASMModuleFromVariant, QuickJSAsyncContext } from 'quickjs-emscripten-core';
import singlefileVariant from '@jitl/quickjs-singlefile-browser-release-asyncify';

// We'll dynamically import esbuild-wasm from esm.sh at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esbuild: any = null;

// QuickJS context for sandboxed execution
let quickJSContext: QuickJSAsyncContext | null = null;

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

            // TypeScript/Node.js commands
            case 'tsc':
                return await shellTsc(args);

            case 'node':
                return await shellNode(args);

            case 'tsx':
                return await shellTsx(args);

            case 'npx':
                return await shellNpx(args);

            default:
                return `sh: ${cmd}: command not found. Type 'help' for available commands.`;
        }
    } catch (e: any) {
        return `${cmd}: ${e.message}`;
    }
}

const cmds = ['echo', 'pwd', 'date', 'cat', 'ls', 'mkdir', 'rm', 'touch', 'cp', 'mv', 'head', 'tail', 'wc', 'find', 'grep', 'sort', 'uniq', 'tee', 'which', 'help', 'tsc', 'node', 'tsx', 'npx'];

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

// ============ tsc / node / tsx Commands ============

async function shellTsc(args: string[]): Promise<string> {
    await initEsbuild();

    const paths = args.filter(a => !a.startsWith('-'));
    if (paths.length === 0) return 'tsc: no input files';

    const results: string[] = [];

    for (const filePath of paths) {
        if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) {
            results.push(`tsc: ${filePath}: not a TypeScript file`);
            continue;
        }

        try {
            const code = await readFile(filePath);
            const transformed = transformImports(code);

            // Use esbuild to compile - it will throw on errors
            const result = await esbuild.transform(transformed, {
                loader: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
                format: 'esm',
                target: 'es2022',
            });

            // Write the compiled JS file
            const jsPath = filePath.replace(/\.tsx?$/, '.js');
            await writeFile(jsPath, result.code);

            results.push(`✓ ${filePath} → ${jsPath}`);

            // Show any warnings
            if (result.warnings && result.warnings.length > 0) {
                for (const warn of result.warnings) {
                    results.push(`  ⚠ ${warn.text}`);
                }
            }
        } catch (e: any) {
            // Format compilation errors nicely
            if (e.errors) {
                for (const err of e.errors) {
                    const loc = err.location ? `:${err.location.line}:${err.location.column}` : '';
                    results.push(`✗ ${filePath}${loc}: ${err.text}`);
                }
            } else {
                results.push(`✗ ${filePath}: ${e.message}`);
            }
        }
    }

    return results.join('\n');
}

async function shellNode(args: string[]): Promise<string> {
    await initEsbuild();

    const paths = args.filter(a => !a.startsWith('-'));
    if (paths.length === 0) return 'node: no input file';

    const filePath = paths[0];

    try {
        const code = await readFile(filePath);
        // Run the JS code through our execution framework
        return await executeCode(code, 'js');
    } catch (e: any) {
        return `node: ${e.message}`;
    }
}

async function shellTsx(args: string[]): Promise<string> {
    await initEsbuild();

    const paths = args.filter(a => !a.startsWith('-'));
    if (paths.length === 0) return 'tsx: no input file';

    const filePath = paths[0];

    try {
        const code = await readFile(filePath);
        // Compile and run the TypeScript code
        return await executeTypeScript(code);
    } catch (e: any) {
        // Format compilation errors nicely
        if (e.errors) {
            const results: string[] = [];
            for (const err of e.errors) {
                const loc = err.location ? `:${err.location.line}:${err.location.column}` : '';
                results.push(`✗ ${filePath}${loc}: ${err.text}`);
            }
            return results.join('\n');
        }
        return `tsx: ${e.message}`;
    }
}

async function shellNpx(args: string[]): Promise<string> {
    if (args.length === 0) return 'npx: no command specified';

    const subCmd = args[0];
    const subArgs = args.slice(1);

    switch (subCmd) {
        case 'tsx':
        case 'ts-node':
            // npx tsx file.ts - run TypeScript directly
            return await shellTsx(subArgs);

        case 'tsc':
            // npx tsc file.ts - compile TypeScript
            return await shellTsc(subArgs);

        default:
            // For other packages, try to run if it looks like a .ts or .js file
            if (subCmd.endsWith('.ts') || subCmd.endsWith('.tsx')) {
                return await shellTsx([subCmd, ...subArgs]);
            } else if (subCmd.endsWith('.js')) {
                return await shellNode([subCmd, ...subArgs]);
            }
            return `npx: '${subCmd}' - package execution not supported. Use 'tsx' for TypeScript files.`;
    }
}

// Helper to execute both JS and TS code
async function executeCode(code: string, _loader: 'js' | 'ts' | 'tsx' = 'ts'): Promise<string> {
    // executeTypeScript can handle JS too since esbuild supports JavaScript
    return await executeTypeScript(code);
}

// ============ QuickJS Sandbox ============

// Host-side logs array for capturing QuickJS console output
let capturedLogs: string[] = [];

async function initQuickJS(): Promise<QuickJSAsyncContext> {
    if (quickJSContext) return quickJSContext;

    console.log('[QuickJS] Initializing async context with singlefile variant...');
    // Use singlefile variant - embeds WASM as base64, no separate file loading
    const module = await newQuickJSAsyncWASMModuleFromVariant(singlefileVariant);
    const ctx = module.newContext();

    // ===== Host function to capture logs =====
    // This captures logs to the host-side array (much simpler than QuickJS array manipulation)
    const captureLogFn = ctx.newFunction('__captureLog', (...args) => {
        const nativeArgs = args.map(arg => ctx.dump(arg));
        const logStr = nativeArgs.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        console.log('[QuickJS stdout]:', logStr);
        capturedLogs.push(logStr);
    });
    ctx.setProp(ctx.global, '__captureLog', captureLogFn);
    captureLogFn.dispose();

    // ===== console object =====
    // Console methods push to host-side capturedLogs array (via closure)
    const consoleObj = ctx.newObject();

    // console.log
    const logFn = ctx.newFunction('log', (...args) => {
        const nativeArgs = args.map(arg => ctx.dump(arg));
        const logStr = nativeArgs.map(a =>
            typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');
        console.log('[QuickJS stdout]:', logStr);
        capturedLogs.push(logStr);
    });
    ctx.setProp(consoleObj, 'log', logFn);
    logFn.dispose();

    // console.error, console.warn, console.info 
    for (const method of ['error', 'warn', 'info'] as const) {
        const fn = ctx.newFunction(method, (...args) => {
            const nativeArgs = args.map(arg => ctx.dump(arg));
            const prefix = method.toUpperCase() + ': ';
            const logStr = prefix + nativeArgs.map(a =>
                typeof a === 'object' ? JSON.stringify(a) : String(a)
            ).join(' ');
            console.log('[QuickJS stdout]:', logStr);
            capturedLogs.push(logStr);
        });
        ctx.setProp(consoleObj, method, fn);
        fn.dispose();
    }

    ctx.setProp(ctx.global, 'console', consoleObj);
    consoleObj.dispose();

    // ===== fetch function (async via asyncify) =====
    const fetchFn = ctx.newAsyncifiedFunction('fetch', async (urlHandle, optionsHandle) => {
        const url = ctx.getString(urlHandle);
        const options = optionsHandle ? ctx.dump(optionsHandle) : undefined;

        console.log('[QuickJS] fetch:', url, options?.method || 'GET');

        try {
            const response = await fetch(url, options);
            const text = await response.text();
            console.log('[QuickJS] fetch response:', response.status, text.length, 'chars');

            // Return a response-like object
            const respObj = ctx.newObject();
            ctx.setProp(respObj, 'ok', ctx.newNumber(response.ok ? 1 : 0));
            ctx.setProp(respObj, 'status', ctx.newNumber(response.status));
            ctx.setProp(respObj, 'statusText', ctx.newString(response.statusText));
            ctx.setProp(respObj, '_body', ctx.newString(text));

            // text() method
            const textMethod = ctx.newFunction('text', () => {
                return ctx.getProp(respObj, '_body');
            });
            ctx.setProp(respObj, 'text', textMethod);
            textMethod.dispose();

            // json() method
            const jsonMethod = ctx.newFunction('json', () => {
                const bodyHandle = ctx.getProp(respObj, '_body');
                const bodyStr = ctx.getString(bodyHandle);
                bodyHandle.dispose();
                const parseResult = ctx.evalCode(`(${bodyStr})`);
                if (parseResult.error) {
                    parseResult.error.dispose();
                    throw ctx.newError('Invalid JSON');
                }
                return parseResult.value;
            });
            ctx.setProp(respObj, 'json', jsonMethod);
            jsonMethod.dispose();

            return respObj;
        } catch (e: any) {
            console.error('[QuickJS] fetch error:', e.message);
            throw ctx.newError(e.message);
        }
    });
    ctx.setProp(ctx.global, 'fetch', fetchFn);
    fetchFn.dispose();

    // ===== fs.promises object (async via asyncify) =====
    const fsObj = ctx.newObject();
    const promisesObj = ctx.newObject();

    // fs.promises.readFile
    const readFileFn = ctx.newAsyncifiedFunction('readFile', async (pathHandle) => {
        const p = ctx.getString(pathHandle);
        console.log('[QuickJS] fs.readFile:', p);
        const content = await readFile(p);
        return ctx.newString(content);
    });
    ctx.setProp(promisesObj, 'readFile', readFileFn);
    readFileFn.dispose();

    // fs.promises.writeFile
    const writeFileFn = ctx.newAsyncifiedFunction('writeFile', async (pathHandle, dataHandle) => {
        const p = ctx.getString(pathHandle);
        const data = ctx.getString(dataHandle);
        console.log('[QuickJS] fs.writeFile:', p, `(${data.length} chars)`);
        await writeFile(p, data);
        return ctx.undefined;
    });
    ctx.setProp(promisesObj, 'writeFile', writeFileFn);
    writeFileFn.dispose();

    // fs.promises.readdir
    const readdirFn = ctx.newAsyncifiedFunction('readdir', async (pathHandle) => {
        const p = ctx.getString(pathHandle);
        console.log('[QuickJS] fs.readdir:', p);
        const entries = await listDir(p);
        const arr = ctx.newArray();
        entries.forEach((entry, i) => {
            ctx.setProp(arr, i, ctx.newString(entry));
        });
        return arr;
    });
    ctx.setProp(promisesObj, 'readdir', readdirFn);
    readdirFn.dispose();

    ctx.setProp(fsObj, 'promises', promisesObj);
    promisesObj.dispose();
    ctx.setProp(ctx.global, 'fs', fsObj);
    fsObj.dispose();

    // ===== path object (pure JS, no async needed) =====
    ctx.evalCode(`
        globalThis.path = {
            join: (...p) => p.filter(Boolean).join('/').replace(/\\/\\/+/g, '/'),
            resolve: (...p) => '/' + p.filter(Boolean).join('/').replace(/\\/\\/+/g, '/').replace(/^\\/+/, ''),
            dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
            basename: (p, ext) => { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
            extname: (p) => { const b = p.split('/').pop() || ''; const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
            sep: '/',
            delimiter: ':',
        };
    `);

    // ===== Module loader for ES module imports =====
    // Async module loader can return promises - execution suspends until resolved
    ctx.runtime.setModuleLoader(async (moduleName: string) => {
        console.log('[QuickJS] Loading module:', moduleName);

        try {
            // Handle npm packages - fetch from esm.sh
            if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
                const esmUrl = `https://esm.sh/${moduleName}`;
                console.log('[QuickJS] Fetching from esm.sh:', esmUrl);
                const response = await fetch(esmUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${esmUrl}: ${response.status}`);
                }
                const code = await response.text();
                console.log('[QuickJS] Loaded module:', moduleName, `(${code.length} chars)`);
                return code;
            }

            // Handle local file imports
            const normalizedPath = moduleName.startsWith('/') ? moduleName : `/${moduleName}`;
            console.log('[QuickJS] Loading local module:', normalizedPath);
            const content = await readFile(normalizedPath);
            return content;
        } catch (e: any) {
            console.error('[QuickJS] Module load error:', moduleName, e.message);
            throw e;
        }
    });

    console.log('[QuickJS] Context initialized with console, fetch, fs, path, module loader');
    quickJSContext = ctx;
    return ctx;
}

async function runInQuickJS(jsCode: string, options?: { type?: 'module' | 'global' }): Promise<string> {
    const ctx = await initQuickJS();

    // Clear the host-side logs array before execution
    capturedLogs = [];

    // Default timeout: 30 seconds
    const timeoutMs = 30000;
    const deadline = Date.now() + timeoutMs;

    // Set interrupt handler to catch infinite CPU loops
    ctx.runtime.setInterruptHandler(() => {
        return Date.now() > deadline;
    });

    try {
        // Run code with timeout race for async hangs
        const resultPromise = ctx.evalCodeAsync(jsCode, 'user-code.js', options);

        const timeoutPromise = new Promise<{ error: any }>((_, reject) => {
            setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        const result = await Promise.race([resultPromise, timeoutPromise]) as any;

        if (result.error) {
            const errorVal = ctx.dump(result.error);
            result.error.dispose();
            const errorMsg = typeof errorVal === 'object' && errorVal !== null
                ? (errorVal.message || errorVal.stack || JSON.stringify(errorVal))
                : String(errorVal);
            return `Error: ${errorMsg}`;
        }

        // Handle module exports or direct result
        const valueHandle = result.value;

        // If the result is a promise, we need to await it
        if (ctx.typeof(valueHandle) === 'object') {
            try {
                // Also race the promise resolution
                const resolvedResult = await Promise.race([
                    ctx.resolvePromise(valueHandle),
                    timeoutPromise
                ]) as any;

                if (resolvedResult.error) {
                    const errorVal = ctx.dump(resolvedResult.error);
                    resolvedResult.error.dispose();
                    const errorMsg = typeof errorVal === 'object' && errorVal !== null
                        ? (errorVal.message || errorVal.stack || JSON.stringify(errorVal))
                        : String(errorVal);
                    return `Error: ${errorMsg}`;
                }
                resolvedResult.value.dispose();
            } catch (e: any) {
                // If resolvePromise fails or times out
                if (e.message?.includes('timed out')) {
                    throw e;
                }
            }
        }

        valueHandle.dispose();

        // Execute any pending jobs
        ctx.runtime.executePendingJobs();

        // Return captured logs from host-side array
        return capturedLogs.length > 0 ? capturedLogs.join('\n') : '(no output)';

    } catch (e: any) {
        // Clear interrupt handler
        ctx.runtime.setInterruptHandler(() => false);

        // Critical error or timeout - dispose context to ensure next run is clean
        console.error('[QuickJS] Critical error or timeout, disposing context:', e);
        if (quickJSContext) {
            try { quickJSContext.dispose(); } catch (disposeError) {
                console.error('[QuickJS] Error disposing context:', disposeError);
            }
            quickJSContext = null;
        }

        return `Error: ${e.message}`;
    } finally {
        // Always clear interrupt handler
        ctx.runtime.setInterruptHandler(() => false);
    }
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

    // Compile TypeScript to JavaScript, keeping imports
    // Our module loader will handle fetching npm packages from esm.sh
    const result = await esbuild.transform(code, {
        loader: 'tsx',
        format: 'esm',
        target: 'es2020',
    });

    // Wrap code to capture output and auto-run entry functions
    const wrappedCode = `
${result.code}

// Auto-detect and call common async entry point functions
const __entryPoints = ['main', 'run', 'start', 'fetchData', 'fetchUser', 'execute', 'init'];
for (const name of __entryPoints) {
    if (typeof globalThis[name] === 'function') {
        const result = globalThis[name]();
        if (result instanceof Promise) {
            await result;
        }
        break;
    }
}
`;

    // Execute as ES module in QuickJS sandbox
    return await runInQuickJS(wrappedCode, { type: 'module' });
}

// No longer needed - module loader handles imports
function stripImports(code: string): string {
    // Remove all import statements
    return code.replace(/import\s+.*?from\s+['"](.*?)['"];?\s*\n?/g, (match, pkg) => {
        // Log what we're stripping for debugging
        console.log('[esbuild] Stripped import:', pkg);
        return '';
    });
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
async function executeJs(code: string): Promise<string> {
    // Use QuickJS sandbox for all JavaScript execution
    return await runInQuickJS(code);
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
                output = await executeJs(tool.input.code as string);
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
