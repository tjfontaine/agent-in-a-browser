import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Spinner, renderToolOutput } from './tui';
import { WasmAgent } from './agent-sdk';

const API_URL = 'http://localhost:3001';


// Get API key from environment or use dummy key (backend handles actual auth)
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || 'dummy-key-for-proxy';

// ============ Terminal Setup ============

const terminal = new Terminal({
    theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f7866',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
    },
    fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace",
    fontSize: 14,
    cursorBlink: true,
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById('terminal')!);
fitAddon.fit();

window.addEventListener('resize', () => fitAddon.fit());

// ============ WASM Agent Setup ============

// Agent uses the WASM MCP server directly (no worker needed)
let agent: WasmAgent | null = null;

let mcpInitialized = false;
let mcpServerInfo: { name: string; version: string } | null = null;
let mcpToolsList: Array<{ name: string; description?: string }> = [];

// Initialize Sandbox Worker
const sandbox = new Worker(new URL('./sandbox-worker.ts', import.meta.url), { type: 'module' });

// Pending tool calls
const pendingToolCalls = new Map<string, (result: any) => void>();

sandbox.postMessage({ type: 'init' });

sandbox.onmessage = (event) => {
    const { type, message, tools: workerTools, id, result, serverInfo } = event.data;

    if (type === 'status') {
        setStatus(message, '#d29922');
    } else if (type === 'ready') {
        setStatus('Ready', '#3fb950');
        // Clear the "Initializing sandbox..." line and show Ready!
        terminal.write('\x1b[A\r\x1b[K'); // Move up one line and clear it
        terminal.write('\x1b[32m✓ Sandbox ready\x1b[0m\r\n');
        sandbox.postMessage({ type: 'get_tools' });
        showPrompt();
    } else if (type === 'mcp-initialized') {
        mcpInitialized = true;
        mcpServerInfo = serverInfo;
        mcpToolsList = event.data.tools || [];
        console.log('MCP Server initialized:', serverInfo);
        console.log('MCP Tools:', event.data.tools);
        terminal.write(`\x1b[32m✓ MCP Server ready: ${serverInfo.name} v${serverInfo.version}\x1b[0m\r\n`);
        terminal.write(`\x1b[90m  ${event.data.tools.length} tools available\x1b[0m\r\n`);

        // Initialize Agent with the system prompt
        agent = new WasmAgent({
            model: 'claude-sonnet-4-5',
            baseURL: API_URL,
            apiKey: ANTHROPIC_API_KEY,
            systemPrompt: SYSTEM_PROMPT,
            maxSteps: 15,
        });
        terminal.write(`\x1b[32m✓ Agent ready\x1b[0m\r\n`);
    } else if (type === 'tools') {
        // Tools now managed by agent SDK via MCP bridge
        console.log('Loaded tools:', workerTools?.map((t: any) => t.name));
    } else if (type === 'tool_result') {
        const resolver = pendingToolCalls.get(id);
        if (resolver) {
            resolver(result);
            pendingToolCalls.delete(id);
        }
    } else if (type === 'console') {
        // Console output from QuickJS
        terminal.write(`\x1b[90m[js] ${message}\x1b[0m\r\n`);
    } else if (type === 'error') {
        setStatus('Error', '#ff7b72');
        terminal.write(`\x1b[31mError: ${message}\x1b[0m\r\n`);
    }
};

async function callTool(name: string, input: Record<string, unknown>): Promise<any> {
    return new Promise((resolve) => {
        const id = crypto.randomUUID();
        const requestId = Date.now();

        // Handler for mcp-response messages
        const handler = (event: MessageEvent) => {
            if (event.data.type === 'mcp-response' && event.data.response?.id === requestId) {
                sandbox.removeEventListener('message', handler);
                const response = event.data.response;
                if (response.error) {
                    resolve({ error: response.error.message });
                } else {
                    // Extract text from content array
                    const content = response.result?.content || [];
                    const output = content.map((c: any) => c.text).filter(Boolean).join('\n');
                    resolve({ output, isError: response.result?.isError });
                }
            }
        };
        sandbox.addEventListener('message', handler);

        // Send as MCP JSON-RPC request
        sandbox.postMessage({
            type: 'mcp-request',
            id,
            request: {
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: { name, arguments: input }
            }
        });
    });
}

// ============ Status Display ============

function setStatus(status: string, color = '#3fb950') {
    const el = document.getElementById('status')!;
    el.textContent = status;
    el.style.color = color;
}

// ============ Conversation State ============

// Agent manages its own conversation history

const SYSTEM_PROMPT = `You are a helpful AI assistant running in a WASM sandbox.

# Tone and Style
- Keep responses short and concise for CLI output
- Use Github-flavored markdown for formatting
- No emojis unless explicitly requested
- Be direct and professional

# Available Tools

## Code Execution
- eval: Execute JavaScript/TypeScript code synchronously
- transpile: Convert TypeScript to JavaScript

## File Operations
- read_file: Read file contents from OPFS
- write_file: Create/overwrite files in OPFS
- list_dir: List directory contents

# Synchronous Fetch Available

The eval tool includes a synchronous \`fetch()\` function for HTTP requests.
This is NOT the async browser fetch - it blocks and returns immediately with results.

## How to Use Fetch

\`\`\`javascript
// Make a GET request - NO await needed, it's synchronous!
const response = fetch('https://api.example.com/data');
console.log('Status:', response.status);
console.log('OK:', response.ok);

// Get response body as text
const text = response.text();

// Get response body as JSON
const data = response.json();
console.log(data);
\`\`\`

IMPORTANT: Do NOT use await with fetch - it's synchronous and will return immediately.

# Environment
- Files persist in OPFS (Origin Private File System)
- Synchronous file operations work via write_file/read_file
- \`fetch()\` is available for HTTP requests (synchronous, returns immediately)`;

// ============ Agent Loop ============

// Debug logging - goes to browser console
function debug(...args: any[]) {
    console.log('[Agent]', new Date().toISOString().slice(11, 23), ...args);
}

let inputBuffer = '';
let spinner: Spinner | null = null;
let cancelRequested = false;
let abortController: AbortController | null = null;

async function sendMessage(userMessage: string): Promise<void> {
    // Handle slash commands
    if (userMessage.startsWith('/')) {
        handleSlashCommand(userMessage);
        return;
    }

    setStatus('Thinking...', '#d29922');
    terminal.write('\r\n');

    // Start spinner
    spinner = new Spinner(terminal);
    spinner.start('Thinking...');
    cancelRequested = false; // Reset cancel flag
    abortController = new AbortController(); // Create new abort controller

    debug('User message:', userMessage);
    await runAgentLoop(userMessage);
}

function handleSlashCommand(command: string): void {
    const cmd = command.slice(1).toLowerCase();

    switch (cmd) {
        case 'clear':
            terminal.clear();
            if (agent) agent.clearHistory();
            terminal.write('\x1b[90mConversation cleared.\x1b[0m\r\n');
            break;
        case 'files':
            callTool('list', { path: '/' }).then((result) => {
                terminal.write('\r\n\x1b[36mFiles:\x1b[0m\r\n');
                terminal.write(result.output || result.error || '(empty)');
                terminal.write('\r\n');
                showPrompt();
            });
            return;
        case 'mcp':
            terminal.write('\r\n\x1b[36m┌─ MCP Status ─────────────────────────\x1b[0m\r\n');
            terminal.write(`\x1b[36m│\x1b[0m Initialized: ${mcpInitialized ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}\r\n`);
            terminal.write(`\x1b[36m│\x1b[0m Agent SDK:   ${agent ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}\r\n`);
            if (mcpServerInfo) {
                terminal.write(`\x1b[36m│\x1b[0m\r\n`);
                terminal.write(`\x1b[36m│\x1b[0m \x1b[1m${mcpServerInfo.name}\x1b[0m v${mcpServerInfo.version}\r\n`);
                terminal.write(`\x1b[36m│\x1b[0m Tools (${mcpToolsList.length}):\r\n`);
                for (const tool of mcpToolsList) {
                    const desc = tool.description ? ` - ${tool.description.substring(0, 50)}${tool.description.length > 50 ? '...' : ''}` : '';
                    terminal.write(`\x1b[36m│\x1b[0m   \x1b[33m${tool.name}\x1b[0m\x1b[90m${desc}\x1b[0m\r\n`);
                }
            }
            terminal.write('\x1b[36m└──────────────────────────────────────\x1b[0m\r\n');
            if (!agent && !ANTHROPIC_API_KEY) {
                terminal.write('\r\n\x1b[33mSet VITE_ANTHROPIC_API_KEY to enable Agent SDK\x1b[0m\r\n');
            }
            break;
        case 'help':
            terminal.write('\r\n\x1b[36mCommands:\x1b[0m\r\n');
            terminal.write('  /clear - Clear conversation\r\n');
            terminal.write('  /files - List files in sandbox\r\n');
            terminal.write('  /mcp   - Show MCP status\r\n');
            terminal.write('  /help  - Show this help\r\n');
            break;
        default:
            terminal.write(`\r\n\x1b[31mUnknown command: ${command} \x1b[0m\r\n`);
    }
    showPrompt();
}

async function runAgentLoop(userMessage: string): Promise<void> {
    // Check if cancelled before making API call
    if (cancelRequested) {
        debug('Agent loop cancelled');
        return;
    }

    if (!agent || !mcpInitialized) {
        terminal.write(`\r\n\x1b[31mError: Agent not initialized.Please wait for MCP to initialize.\x1b[0m\r\n`);
        if (spinner) spinner.stop();
        spinner = null;
        showPrompt();
        setStatus('Error', '#ff7b72');
        return;
    }

    await runAgentLoopWithSDK(userMessage);
}

async function runAgentLoopWithSDK(userMessage: string): Promise<void> {
    // Stop the initial thinking spinner - we'll show progress via callbacks
    if (spinner) spinner.stop();
    spinner = null;

    // Use object wrapper to prevent TypeScript type narrowing issues with closures
    const state = { toolSpinner: null as Spinner | null, firstTextReceived: false };

    try {
        await agent!.stream(userMessage, {
            onText: (text) => {
                // Stop spinner on first text
                if (!state.firstTextReceived) {
                    state.firstTextReceived = true;
                    if (state.toolSpinner) {
                        state.toolSpinner.stop();
                        state.toolSpinner = null;
                    }
                }
                terminal.write(text.replace(/\n/g, '\r\n'));
            },
            onToolCall: (name, input) => {
                // Show tool execution spinner
                const args = (input as any).path || (input as any).command || (input as any).code || '';
                const argsDisplay = typeof args === 'string'
                    ? (args.length > 30 ? args.substring(0, 27) + '...' : args)
                    : '';
                state.toolSpinner = new Spinner(terminal);
                state.toolSpinner.start(`${name} ${argsDisplay} `);
                setStatus('Executing...', '#bc8cff');
            },
            onToolResult: (name, result, success) => {
                // Stop tool spinner and show result
                if (state.toolSpinner) {
                    state.toolSpinner.stop();
                    state.toolSpinner = null;
                }
                renderToolOutput(terminal, name, '', result, success);
                setStatus('Thinking...', '#d29922');
            },
            onStepFinish: (step) => {
                debug('Step completed:', step);
            },
            onError: (error) => {
                if (state.toolSpinner) {
                    state.toolSpinner.stop();
                    state.toolSpinner = null;
                }
                // Only show error if not cancelled
                if (!cancelRequested && error.name !== 'AbortError') {
                    terminal.write(`\r\n\x1b[31mError: ${error.message} \x1b[0m\r\n`);
                    setStatus('Error', '#ff7b72');
                }
            },
            onFinish: (steps) => {
                debug('Agent finished with steps:', steps);
            }
        });

        abortController = null;
        showPrompt();
        setStatus('Ready', '#3fb950');
    } catch (error: any) {
        // Don't show error if user cancelled
        if (error.name === 'AbortError' || cancelRequested) {
            debug('Request aborted by user');
            if (state.toolSpinner) state.toolSpinner.stop();
            abortController = null;
            return;
        }
        terminal.write(`\r\n\x1b[31mError: ${error.message} \x1b[0m\r\n`);
        setStatus('Error', '#ff7b72');
        abortController = null;
        showPrompt();
    }
}

// ============ Input Handling ============

function showPrompt(): void {
    terminal.write('\r\n\x1b[36m❯\x1b[0m ');
}

terminal.onData((data) => {
    const code = data.charCodeAt(0);

    // ESC key (27) cancels agent execution
    if (code === 27) {
        if (spinner || abortController) {
            cancelRequested = true;
            // Abort any in-flight API request
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
            if (spinner) {
                spinner.stop('Cancelled');
                spinner = null;
            }
            terminal.write('\r\n\x1b[33m⚠ Cancelled by user\x1b[0m');
            setStatus('Ready', '#3fb950');
            showPrompt();
            debug('User cancelled execution');
        }
        return;
    }

    if (code === 13) {
        if (inputBuffer.trim()) {
            sendMessage(inputBuffer.trim());
        } else {
            showPrompt();
        }
        inputBuffer = '';
    } else if (code === 127) {
        if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            terminal.write('\b \b');
        }
    } else if (code >= 32) {
        inputBuffer += data;
        terminal.write(data);
    }
});

// ============ Welcome ============



terminal.write('\x1b[36m╭────────────────────────────────────────────╮\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  \x1b[1mWeb Agent\x1b[0m - Browser Edition              \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  Files persist in OPFS sandbox            \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  Type /help for commands                  \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m╰────────────────────────────────────────────╯\x1b[0m\r\n');
terminal.write('\x1b[90mInitializing sandbox...\x1b[0m\r\n');

// Prompt will be shown when sandbox is ready
terminal.focus();
