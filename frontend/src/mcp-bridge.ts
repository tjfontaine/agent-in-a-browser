/**
 * MCP Bridge Client
 * 
 * Connects to a WebSocket bridge server and exposes the browser's WASM 
 * sandbox as an MCP server. External clients (like Claude Desktop) can
 * connect to the bridge via HTTP.
 * 
 * Flow:
 * Claude Desktop -> HTTP :3050 -> Bridge -> WS :3040 -> This Page -> WASM Sandbox
 */

import './mcp-bridge.css';
import { initFilesystem } from '@tjfontaine/wasi-shims';
import { loadMcpServer, callWasmMcpServerFetch } from '@tjfontaine/mcp-wasm-server';

// --- State ---
let ws: WebSocket | null = null;
let mcpReady = false;
let toolsList: Array<{ name: string; description?: string }> = [];

// --- DOM Elements ---
const statusEl = document.getElementById('bridge-status')!;
const statusTextEl = document.getElementById('status-text')!;
const logEl = document.getElementById('activity-log')!;
const toolsListEl = document.getElementById('tools-list')!;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const clearLogBtn = document.getElementById('clear-log')!;
const bridgeUrlInput = document.getElementById('bridge-url') as HTMLInputElement;

// --- Logging ---
function log(type: 'info' | 'in' | 'out' | 'error' | 'success', message: string, details?: string) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-type">${getTypeLabel(type)}</span>
        <span class="log-content">${escapeHtml(message)}</span>
        ${details ? `<pre class="log-details">${escapeHtml(details)}</pre>` : ''}
    `;

    logEl.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth' });
}

function getTypeLabel(type: string): string {
    switch (type) {
        case 'in': return '← REQ';
        case 'out': return '→ RES';
        case 'error': return '✗ ERR';
        case 'success': return '✓ OK';
        default: return 'ℹ INFO';
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setStatus(state: 'connected' | 'disconnected' | 'connecting', text: string) {
    statusEl.className = `status ${state}`;
    statusTextEl.textContent = text;
}

// --- MCP Initialization ---
async function initMcp(): Promise<void> {
    log('info', 'Initializing OPFS filesystem...');
    await initFilesystem();

    log('info', 'Loading MCP WASM server...');
    await loadMcpServer();

    mcpReady = true;
    log('success', 'MCP server ready');

    // Fetch available tools
    await fetchTools();
}

async function fetchTools(): Promise<void> {
    try {
        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 'init' })
        });

        const response = await callWasmMcpServerFetch(request);
        const body = await readResponseBody(response.body);
        const parsed = JSON.parse(body);

        if (parsed.result?.tools) {
            toolsList = parsed.result.tools;
            renderToolsList();
        }
    } catch (e) {
        log('error', 'Failed to fetch tools', String(e));
    }
}

function renderToolsList(): void {
    if (toolsList.length === 0) {
        toolsListEl.innerHTML = '<p class="tools-placeholder">No tools available</p>';
        return;
    }

    toolsListEl.innerHTML = toolsList.map(tool => `
        <div class="tool-item">
            <span class="tool-name">${escapeHtml(tool.name)}</span>
            ${tool.description ? `<span class="tool-desc">${escapeHtml(tool.description)}</span>` : ''}
        </div>
    `).join('');
}

// --- WebSocket Message Handling ---
async function handleMessage(data: string): Promise<void> {
    // Protocol: "REQ_ID:METHOD:URL:BODY"
    const firstColon = data.indexOf(':');
    const secondColon = data.indexOf(':', firstColon + 1);
    const thirdColon = data.indexOf(':', secondColon + 1);

    if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
        log('error', 'Invalid message format', data.slice(0, 100));
        return;
    }

    const reqId = data.slice(0, firstColon);
    const method = data.slice(firstColon + 1, secondColon);
    const url = data.slice(secondColon + 1, thirdColon);
    const body = data.slice(thirdColon + 1);

    // Parse and display the MCP request nicely
    let mcpMethod = '?';
    let mcpParams = '';
    try {
        const parsed = JSON.parse(body);
        mcpMethod = parsed.method || '?';
        if (parsed.params) {
            mcpParams = JSON.stringify(parsed.params, null, 2);
        }
    } catch {
        // Not JSON, just show raw
    }

    log('in', `[${reqId}] ${mcpMethod}`, mcpParams || body.slice(0, 200));

    try {
        // Create a Request object for callWasmMcpServerFetch
        const request = new Request(`http://localhost${url}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body || undefined
        });

        const response = await callWasmMcpServerFetch(request);
        const responseBody = await readResponseBody(response.body);

        // Parse response for nice display
        let resultSummary = responseBody.slice(0, 100);
        try {
            const parsed = JSON.parse(responseBody);
            if (parsed.result) {
                resultSummary = JSON.stringify(parsed.result).slice(0, 200);
            } else if (parsed.error) {
                resultSummary = `Error: ${parsed.error.message}`;
            }
        } catch {
            // Not JSON
        }

        log('out', `[${reqId}] ${response.status} - ${resultSummary}`);

        // Send back: "REQ_ID:STATUS:BODY"
        ws!.send(`${reqId}:${response.status}:${responseBody}`);

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log('error', `[${reqId}] Execution failed`, errMsg);

        const errorResponse = JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: errMsg },
            id: null
        });
        ws!.send(`${reqId}:500:${errorResponse}`);
    }
}

async function readResponseBody(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder().decode(combined);
}

// --- Connection ---
async function connect(): Promise<void> {
    if (!mcpReady) {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Initializing...';
        await initMcp();
    }

    const url = bridgeUrlInput.value.trim();
    if (!url) {
        log('error', 'Please enter a bridge URL');
        return;
    }

    setStatus('connecting', 'Connecting...');
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    log('info', `Connecting to ${url}...`);

    try {
        ws = new WebSocket(url);

        ws.onopen = () => {
            setStatus('connected', 'Connected');
            log('success', 'Connected to bridge');
            connectBtn.textContent = 'Disconnect';
            connectBtn.disabled = false;
            connectBtn.onclick = disconnect;
        };

        ws.onmessage = (event) => {
            handleMessage(event.data);
        };

        ws.onclose = () => {
            setStatus('disconnected', 'Disconnected');
            log('info', 'Disconnected from bridge');
            connectBtn.textContent = 'Connect';
            connectBtn.disabled = false;
            connectBtn.onclick = connect;
            ws = null;
        };

        ws.onerror = () => {
            log('error', 'WebSocket connection error');
        };

    } catch (e) {
        log('error', 'Failed to connect', String(e));
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
    }
}

function disconnect(): void {
    if (ws) {
        ws.close();
    }
}

// --- Init ---
function init(): void {
    connectBtn.onclick = connect;
    clearLogBtn.onclick = () => {
        logEl.innerHTML = '';
        log('info', 'Log cleared');
    };

    // Auto-connect if URL param
    const params = new URLSearchParams(window.location.search);
    const autoConnect = params.get('connect');
    if (autoConnect) {
        bridgeUrlInput.value = autoConnect;
        connect();
    }
}

// Boot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
