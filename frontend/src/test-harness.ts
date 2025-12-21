/**
 * Test Harness for MCP Tools
 * 
 * Tests the WASM MCP server tools through the sandbox worker.
 * Uses the proper MCP JSON-RPC protocol.
 */

const output = document.getElementById('output')!;

function log(msg: string, type: 'info' | 'error' | 'success' = 'info') {
    const div = document.createElement('div');
    div.className = `log ${type}`;
    div.textContent = `[${new Date().toISOString().split('T')[1]?.slice(0, -1)}] ${msg}`;
    div.style.color = type === 'error' ? 'red' : type === 'success' ? 'green' : '#333';
    output.appendChild(div);
    console.log(msg);
}

const worker = new Worker(new URL('./sandbox-worker.ts', import.meta.url), { type: 'module' });

let pendingResolvers = new Map<string | number, (result: any) => void>();
let nextId = 1;
let mcpInitialized = false;

worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'mcp-initialized') {
        log(`MCP initialized: ${data.serverInfo.name} v${data.serverInfo.version}`, 'success');
        log(`Available tools: ${data.tools.map((t: any) => t.name).join(', ')}`);
        mcpInitialized = true;
        runTests();
    } else if (data.type === 'mcp-response') {
        const resolve = pendingResolvers.get(data.response.id);
        if (resolve) {
            pendingResolvers.delete(data.response.id);
            resolve(data.response);
        }
    } else if (data.type === 'error') {
        log(`Worker Error: ${data.message}`, 'error');
    }
};

/**
 * Call an MCP tool via JSON-RPC
 */
function callMcpTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean, output: string, error?: string }> {
    return new Promise((resolve) => {
        const id = nextId++;
        pendingResolvers.set(id, (response) => {
            if (response.error) {
                resolve({ success: false, output: '', error: response.error.message });
            } else {
                const result = response.result;
                // MCP returns content array with text items
                const text = result.content?.map((c: any) => c.text).join('\n') || '';
                const isError = result.isError === true;
                resolve({
                    success: !isError,
                    output: text,
                    error: isError ? text : undefined
                });
            }
        });

        worker.postMessage({
            type: 'mcp-request',
            request: {
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name, arguments: args }
            }
        });
    });
}

async function runTests() {
    log('Starting MCP tool tests...');

    try {
        // Test 1: run_typescript with console.log
        log('Test 1: run_typescript with console.log');
        let res = await callMcpTool('run_typescript', { code: 'console.log("Hello MCP")' });
        if (res.success && res.output.includes('Hello MCP')) {
            log('Test 1 Passed', 'success');
        } else {
            log(`Test 1 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 2: run_typescript with fetch
        log('Test 2: run_typescript with fetch');
        res = await callMcpTool('run_typescript', {
            code: `
                const r = await fetch('https://jsonplaceholder.typicode.com/todos/1'); 
                console.log('Status:', r.status);
            `
        });
        if (res.success && res.output.includes('Status: 200')) {
            log('Test 2 Passed', 'success');
        } else {
            log(`Test 2 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 3: write_file and read_file
        log('Test 3: write_file and read_file');
        await callMcpTool('write_file', { path: '/test.txt', content: 'hello mcp' });
        res = await callMcpTool('read_file', { path: '/test.txt' });
        if (res.success && res.output === 'hello mcp') {
            log('Test 3 Passed', 'success');
        } else {
            log(`Test 3 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 4: list directory
        log('Test 4: list directory');
        res = await callMcpTool('list', { path: '/' });
        if (res.success && res.output.includes('test.txt')) {
            log('Test 4 Passed', 'success');
        } else {
            log(`Test 4 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 5: grep
        log('Test 5: grep');
        res = await callMcpTool('grep', { pattern: 'hello', path: '/' });
        if (res.success && res.output.includes('/test.txt')) {
            log('Test 5 Passed', 'success');
        } else {
            log(`Test 5 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 6: TypeScript type annotations
        log('Test 6: TypeScript type annotations');
        res = await callMcpTool('run_typescript', {
            code: `
                const add = (a: number, b: number): number => a + b;
                console.log('Sum:', add(2, 3));
            `
        });
        if (res.success && res.output.includes('Sum: 5')) {
            log('Test 6 Passed', 'success');
        } else {
            log(`Test 6 Failed: ${JSON.stringify(res)}`, 'error');
        }

        log('All tests completed.');

    } catch (e: any) {
        log(`Harness Error: ${e.message}`, 'error');
    }
}
