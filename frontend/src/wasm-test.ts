/**
 * WASM Test Harness entry point
 * This module provides a minimal test interface for E2E testing of the WASM sandbox.
 */

// Import sandbox utilities
// Use fetchFromSandboxSimple for Safari compatibility (MessageChannel fails silently in Safari workers)
import { initializeSandbox, fetchFromSandboxSimple } from './agent/sandbox';
// Import OAuth handler to register window.__mcpOAuthHandler for OAuth tests
import './oauth-handler';

interface TestResult {
    success: boolean;
    output: string;
    error?: string;
}

interface TestHarness {
    ready: boolean;
    shellEval(command: string): Promise<TestResult>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    runShellCommand(command: string, fileContent?: string): Promise<TestResult>;
}

declare global {
    interface Window {
        testHarness: TestHarness;
    }
}

const statusEl = document.getElementById('status')!;
const outputEl = document.getElementById('output')!;

function log(msg: string, type: 'info' | 'error' | 'success' = 'info'): void {
    const color = type === 'error' ? '#ff6b6b' : type === 'success' ? '#6bff6b' : '#aaa';
    outputEl.innerHTML += `<span style="color:${color}">[${new Date().toISOString().slice(11, 23)}] ${msg}</span>\n`;
    console.log(msg);
}

let mcpNextId = 1;

// MCP JSON-RPC request helper
async function mcpRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const request = {
        jsonrpc: '2.0',
        id: mcpNextId++,
        method,
        params
    };

    const response = await fetchFromSandboxSimple('/mcp/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        throw new Error(`MCP Request failed: ${response.status}`);
    }

    return await response.json();
}

// Call an MCP tool and return structured result
async function callMcpTool(name: string, args: Record<string, unknown>): Promise<TestResult> {
    const response = await mcpRequest('tools/call', { name, arguments: args }) as {
        error?: { message: string };
        result?: { content?: { text: string }[]; isError?: boolean };
    };

    if (response.error) {
        return { success: false, output: '', error: response.error.message };
    }

    const result = response.result;
    const text = result?.content?.map(c => c.text).join('\n') || '';
    const isError = result?.isError === true;

    return {
        success: !isError,
        output: text,
        error: isError ? text : undefined
    };
}

// Test harness API exposed to Playwright
window.testHarness = {
    ready: false,

    async shellEval(command: string): Promise<TestResult> {
        try {
            const result = await callMcpTool('shell_eval', { command });
            log(`shell_eval: ${command.substring(0, 50)}${command.length > 50 ? '...' : ''} => ${result.success ? 'OK' : 'FAIL'}`,
                result.success ? 'success' : 'error');
            return result;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`shell_eval error: ${msg}`, 'error');
            return { success: false, output: '', error: msg };
        }
    },

    async writeFile(path: string, content: string): Promise<void> {
        const result = await callMcpTool('write_file', { path, content });
        if (!result.success) {
            throw new Error(result.error || 'write_file failed');
        }
        log(`write_file: ${path}`, 'success');
    },

    async readFile(path: string): Promise<string> {
        const result = await callMcpTool('read_file', { path });
        if (!result.success) {
            throw new Error(result.error || 'read_file failed');
        }
        log(`read_file: ${path}`, 'success');
        return result.output;
    },

    async runShellCommand(command: string, fileContent?: string): Promise<TestResult> {
        // If file content is provided, write it first
        if (fileContent) {
            // Extract filename from command (e.g., "tsx /test.ts" -> "/test.ts")
            const parts = command.split(' ');
            if (parts.length >= 2) {
                const filePath = parts[1];
                await this.writeFile(filePath, fileContent);
            }
        }
        return await this.shellEval(command);
    }
};

// Initialize
async function init(): Promise<void> {
    try {
        log('Initializing sandbox worker...');
        await initializeSandbox();
        log('Sandbox worker ready!', 'success');

        log('Initializing MCP...');
        await mcpRequest('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            clientInfo: { name: 'wasm-test-harness', version: '1.0.0' }
        });
        await mcpRequest('initialized', {});
        log('MCP initialized!', 'success');

        // Mark harness as ready
        window.testHarness.ready = true;
        statusEl.className = 'ready';
        statusEl.textContent = '✓ WASM Sandbox Ready';
        log('Test harness ready!', 'success');

    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Initialization failed: ${msg}`, 'error');
        statusEl.className = 'error';
        statusEl.textContent = `✗ Error: ${msg}`;
    }
}

init();
