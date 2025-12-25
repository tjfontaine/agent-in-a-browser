/**
 * Test Harness for MCP Tools
 * 
 * Tests the WASM MCP server tools through the sandbox worker via workerFetch.
 */

import { fetchFromSandbox } from '../src/agent/sandbox';

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

        // Test 1: tsx inline with console.log
        log('Test 1: tsx inline with console.log');
        let res = await callMcpTool('shell_eval', { command: `tsx -e "console.log('Hello MCP')"` });
        if (res.success && res.output.includes('Hello MCP')) {
            log('Test 1 Passed', 'success');
        } else {
            log(`Test 1 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 2: tsx with top-level await
        log('Test 2: tsx with top-level await');
        res = await callMcpTool('shell_eval', {
            command: 'tsx -e "const x = await Promise.resolve(42); console.log(x)"'
        });
        if (res.success && res.output.includes('42')) {
            log('Test 2 Passed', 'success');
        } else {
            log(`Test 2 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 3: tsx TypeScript type annotations get stripped
        log('Test 3: tsx TypeScript type annotations');
        res = await callMcpTool('shell_eval', {
            command: 'tsx -e "const add = (a: number, b: number): number => a + b; console.log(add(2, 3))"'
        });
        if (res.success && res.output.includes('5')) {
            log('Test 3 Passed', 'success');
        } else {
            log(`Test 3 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 4: tsx file execution
        log('Test 4: tsx file execution');
        await callMcpTool('write_file', {
            path: '/data/test-script.ts',
            content: 'const msg: string = "File works!"; console.log(msg);'
        });
        res = await callMcpTool('shell_eval', { command: 'tsx /data/test-script.ts' });
        if (res.success && res.output.includes('File works!')) {
            log('Test 4 Passed', 'success');
        } else {
            log(`Test 4 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 5: tsx error - missing file
        log('Test 5: tsx error - missing file');
        res = await callMcpTool('shell_eval', { command: 'tsx /nonexistent.ts' });
        if (!res.success || res.output.includes('No such file') || res.error?.includes('No such file')) {
            log('Test 5 Passed (error expected)', 'success');
        } else {
            log(`Test 5 Failed - expected error: ${JSON.stringify(res)}`, 'error');
        }

        // Test 6: tsx error - syntax error shows diagnostics
        log('Test 6: tsx error - syntax error diagnostics');
        res = await callMcpTool('shell_eval', { command: 'tsx -e "const x = {"' });
        if (!res.success || res.output.includes('error') || res.error) {
            log('Test 6 Passed (error expected)', 'success');
        } else {
            log(`Test 6 Failed - expected error: ${JSON.stringify(res)}`, 'error');
        }

        // Test 7: tsx with no code
        log('Test 7: tsx with no code');
        res = await callMcpTool('shell_eval', { command: 'tsx' });
        if (!res.success || res.output.includes('no code') || res.error?.includes('no code')) {
            log('Test 7 Passed (error expected)', 'success');
        } else {
            log(`Test 7 Failed - expected error: ${JSON.stringify(res)}`, 'error');
        }

        // Test 8: tsx arithmetic expression
        log('Test 8: tsx arithmetic');
        res = await callMcpTool('shell_eval', { command: 'tsx -e "console.log(1 + 2 * 3)"' });
        if (res.success && res.output.includes('7')) {
            log('Test 8 Passed', 'success');
        } else {
            log(`Test 8 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 9: write_file and read_file (existing test)
        log('Test 9: write_file and read_file');
        await callMcpTool('write_file', { path: '/test.txt', content: 'hello mcp' });
        res = await callMcpTool('read_file', { path: '/test.txt' });
        if (res.success && res.output === 'hello mcp') {
            log('Test 9 Passed', 'success');
        } else {
            log(`Test 9 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 10: list directory
        log('Test 10: list directory');
        res = await callMcpTool('list', { path: '/' });
        if (res.success && res.output.includes('test.txt')) {
            log('Test 10 Passed', 'success');
        } else {
            log(`Test 10 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 11: grep
        log('Test 11: grep');
        res = await callMcpTool('grep', { pattern: 'hello', path: '/' });
        if (res.success && res.output.includes('/test.txt')) {
            log('Test 11 Passed', 'success');
        } else {
            log(`Test 11 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 12: edit_file - successful edit
        log('Test 12: edit_file successful');
        await callMcpTool('write_file', { path: '/edit-test.txt', content: 'line one\nline two\nline three' });
        res = await callMcpTool('edit_file', { path: '/edit-test.txt', old_str: 'line two', new_str: 'LINE TWO EDITED' });
        if (res.success && res.output.includes('Edited')) {
            // Verify the edit
            const verify = await callMcpTool('read_file', { path: '/edit-test.txt' });
            if (verify.success && verify.output.includes('LINE TWO EDITED') && !verify.output.includes('line two')) {
                log('Test 12 Passed', 'success');
            } else {
                log(`Test 12 Failed - edit not applied: ${JSON.stringify(verify)}`, 'error');
            }
        } else {
            log(`Test 12 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 13: edit_file - old_str not found
        log('Test 13: edit_file not found');
        res = await callMcpTool('edit_file', { path: '/edit-test.txt', old_str: 'nonexistent text', new_str: 'replacement' });
        if (!res.success && res.error?.includes('not found')) {
            log('Test 13 Passed', 'success');
        } else {
            log(`Test 13 Failed - expected error: ${JSON.stringify(res)}`, 'error');
        }

        // Test 14: edit_file - multiple matches
        log('Test 14: edit_file multiple matches');
        await callMcpTool('write_file', { path: '/multi.txt', content: 'foo bar foo' });
        res = await callMcpTool('edit_file', { path: '/multi.txt', old_str: 'foo', new_str: 'FOO' });
        if (!res.success && res.error?.includes('2 times')) {
            log('Test 14 Passed', 'success');
        } else {
            log(`Test 14 Failed - expected multiple match error: ${JSON.stringify(res)}`, 'error');
        }

        log('All tests completed.');

    } catch (e: any) {
        log(`Harness Error: ${e.message}`, 'error');
    }
}

// Start
runTests();

