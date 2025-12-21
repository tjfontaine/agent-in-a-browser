/**
 * Test Harness for MCP Tools
 * 
 * Tests the WASM MCP server tools through the sandbox worker via workerFetch.
 */

import { fetchFromSandbox } from './agent/sandbox';

const output = document.getElementById('output')!;

function log(msg: string, type: 'info' | 'error' | 'success' = 'info') {
    const div = document.createElement('div');
    div.className = `log ${type}`;
    div.textContent = `[${new Date().toISOString().split('T')[1]?.slice(0, -1)}] ${msg}`;
    div.style.color = type === 'error' ? 'red' : type === 'success' ? 'green' : '#333';
    output.appendChild(div);
    console.log(msg);
}

let nextId = 1;

/**
 * Call a generic MCP JSON-RPC method
 */
async function mcpRequest(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++;
    const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
    };

    const response = await fetchFromSandbox('/mcp/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        throw new Error(`MCP Request failed: ${response.status} ${response.statusText}`);
    }

    // For sync requests (if supported) or purely waiting for side-effects.
    // However, our current architecture expects responses via SSE for most things?
    // Or does the POST return the response directly?
    // The WASM bridge streams the response back.
    // If the WASM component returns a response to the POST, we get it here.
    // Let's assume the POST returns the JSON-RPC response directly for now,
    // as that's how `callWasmMcpServerFetch` works (maps req -> resp).

    return await response.json();
}

/**
 * Call an MCP tool
 */
async function callMcpTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean, output: string, error?: string }> {
    try {
        const response = await mcpRequest('tools/call', { name, arguments: args });

        if (response.error) {
            return { success: false, output: '', error: response.error.message };
        }

        const result = response.result;
        // MCP returns content array with text items
        const text = result.content?.map((c: any) => c.text).join('\n') || '';
        const isError = result.isError === true;

        return {
            success: !isError,
            output: text,
            error: isError ? text : undefined
        };
    } catch (e: any) {
        return { success: false, output: '', error: e.message };
    }
}

async function runTests() {
    log('Starting MCP tool tests...');

    try {
        // Init
        log('Initializing MCP...');
        await mcpRequest('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            clientInfo: { name: 'test-harness', version: '1.0.0' }
        });
        await mcpRequest('initialized', {});
        log('MCP Initialized', 'success');

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

// Start
runTests();

