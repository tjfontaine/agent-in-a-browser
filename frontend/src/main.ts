import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Readline } from 'xterm-readline';
import { Spinner, renderToolOutput } from './tui';
import { WasmAgent } from './agent-sdk';
import { getRemoteMCPRegistry, type RemoteMCPServer } from './remote-mcp-registry';
import { parseSlashCommand } from './command-parser';

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
const webLinksAddon = new WebLinksAddon();
const searchAddon = new SearchAddon();
const readline = new Readline();

terminal.loadAddon(fitAddon);
terminal.loadAddon(webLinksAddon);  // Makes URLs clickable
terminal.loadAddon(searchAddon);    // Enables search (Ctrl+Shift+F)
terminal.loadAddon(readline);        // Readline for proper line editing

terminal.open(document.getElementById('terminal')!);
fitAddon.fit();

// Add Ctrl+W (delete word) support - must intercept before browser closes tab
terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
    // Ctrl+W: Delete word backwards
    if (ev.ctrlKey && ev.key === 'w') {
        ev.preventDefault();

        // Access readline's internal state (not publicly typed but available at runtime)
        const state = (readline as any).state;
        if (state && state.line) {
            const line = state.line;
            const buf: string = line.buf;
            const pos: number = line.pos;

            if (pos > 0) {
                // Find word boundary: skip trailing spaces, then delete word chars
                let deleteCount = 0;
                let i = pos - 1;

                // Skip any trailing whitespace
                while (i >= 0 && /\s/.test(buf[i])) {
                    i--;
                    deleteCount++;
                }

                // Delete word characters (non-whitespace)
                while (i >= 0 && !/\s/.test(buf[i])) {
                    i--;
                    deleteCount++;
                }

                if (deleteCount > 0) {
                    state.editBackspace(deleteCount);
                }
            }
        }
        return false; // Prevent xterm from processing this key
    }

    return true; // Let other keys pass through
});

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
        // Don't show prompt yet - wait for MCP to initialize
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

        // Start the readline prompt loop now that everything is initialized
        promptLoop();
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

function handleSlashCommand(input: string): void {
    const parsed = parseSlashCommand(input);

    if (!parsed) {
        terminal.write(`\r\n\x1b[31mInvalid command format\x1b[0m\r\n`);
        showPrompt();
        return;
    }

    const { command, subcommand, args } = parsed;

    switch (command) {
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
            // Pass subcommand and args to MCP handler
            handleMcpCommand(subcommand, args, parsed.options);
            return;
        case 'help':
            terminal.write('\r\n\x1b[36mCommands:\x1b[0m\r\n');
            terminal.write('  /clear              - Clear conversation\r\n');
            terminal.write('  /files              - List files in sandbox\r\n');
            terminal.write('  /mcp                - Show MCP status\r\n');
            terminal.write('  /mcp add <url>      - Add remote MCP server\r\n');
            terminal.write('  /mcp remove <id>    - Remove remote server\r\n');
            terminal.write('  /mcp auth <id> [--client-id <id>] - Authenticate with OAuth\r\n');
            terminal.write('  /mcp connect <id>   - Connect to remote server\r\n');
            terminal.write('  /mcp disconnect <id> - Disconnect from server\r\n');
            terminal.write('  /help               - Show this help\r\n');
            break;
        default:
            terminal.write(`\r\n\x1b[31mUnknown command: /${command}\x1b[0m\r\n`);
            terminal.write('\x1b[90mType /help for available commands\x1b[0m\r\n');
    }
    showPrompt();
}

/**
 * Handle /mcp subcommands for remote server management
 */
async function handleMcpCommand(
    subcommand: string | null,
    args: string[],
    options: Record<string, string | boolean>
): Promise<void> {
    const registry = getRemoteMCPRegistry();

    if (!subcommand) {
        // Show status (default behavior)
        showMcpStatus();
        showPrompt();
        return;
    }

    try {
        switch (subcommand) {
            case 'add': {
                const url = args[0];
                if (!url) {
                    terminal.write('\r\n\x1b[31mUsage: /mcp add <url>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                terminal.write(`\r\n\x1b[90mAdding server: ${url}...\x1b[0m\r\n`);

                try {
                    const server = await registry.addServer({ url });
                    terminal.write(`\x1b[32m✓ Added server: ${server.name} (${server.id})\x1b[0m\r\n`);

                    // Check if auth is required
                    terminal.write('\x1b[90mChecking authentication requirements...\x1b[0m\r\n');
                    const authRequired = await registry.checkAuthRequired(server.id);

                    if (authRequired) {
                        terminal.write('\x1b[33m⚠ OAuth authentication required\x1b[0m\r\n');
                        terminal.write(`\x1b[90mRun: /mcp auth ${server.id} <client_id>\x1b[0m\r\n`);
                    } else {
                        // Try to connect
                        terminal.write('\x1b[90mConnecting...\x1b[0m\r\n');
                        await registry.connectServer(server.id);
                        const updated = registry.getServer(server.id);
                        terminal.write(`\x1b[32m✓ Connected! ${updated?.tools.length || 0} tools available\x1b[0m\r\n`);
                    }
                } catch (e: any) {
                    terminal.write(`\x1b[31m✗ Failed: ${e.message}\x1b[0m\r\n`);
                }
                break;
            }

            case 'remove': {
                const id = args[0];
                if (!id) {
                    terminal.write('\r\n\x1b[31mUsage: /mcp remove <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                try {
                    await registry.removeServer(id);
                    terminal.write(`\r\n\x1b[32m✓ Removed server: ${id}\x1b[0m\r\n`);
                } catch (e: any) {
                    terminal.write(`\r\n\x1b[31m✗ ${e.message}\x1b[0m\r\n`);
                }
                break;
            }

            case 'auth': {
                const id = args[0];
                // Support both --client-id option and positional arg for backwards compat
                const clientId = (options['client-id'] as string) || args[1];
                if (!id) {
                    terminal.write('\r\n\x1b[31mUsage: /mcp auth <id> [--client-id <id>]\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                const server = registry.getServer(id);
                if (!server) {
                    terminal.write(`\r\n\x1b[31m✗ Server not found: ${id}\x1b[0m\r\n`);
                    showPrompt();
                    return;
                }

                const effectiveClientId = clientId || server.oauthClientId;
                if (!effectiveClientId) {
                    terminal.write('\r\n\x1b[31m✗ OAuth client ID required\x1b[0m\r\n');
                    terminal.write('\x1b[90mUsage: /mcp auth <id> --client-id <your-client-id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                terminal.write(`\r\n\x1b[90mOpening OAuth popup for ${server.name}...\x1b[0m\r\n`);
                terminal.write('\x1b[33m⚠ Please complete authentication in the popup window\x1b[0m\r\n');

                try {
                    await registry.authenticateServer(id, effectiveClientId);
                    terminal.write('\x1b[32m✓ Authentication successful!\x1b[0m\r\n');

                    // Auto-connect after auth
                    terminal.write('\x1b[90mConnecting...\x1b[0m\r\n');
                    await registry.connectServer(id);
                    const updated = registry.getServer(id);
                    terminal.write(`\x1b[32m✓ Connected! ${updated?.tools.length || 0} tools available\x1b[0m\r\n`);
                } catch (e: any) {
                    terminal.write(`\x1b[31m✗ Authentication failed: ${e.message}\x1b[0m\r\n`);
                }
                break;
            }

            case 'connect': {
                const id = args[0];
                if (!id) {
                    terminal.write('\r\n\x1b[31mUsage: /mcp connect <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                terminal.write(`\r\n\x1b[90mConnecting to ${id}...\x1b[0m\r\n`);

                try {
                    await registry.connectServer(id);
                    const server = registry.getServer(id);
                    terminal.write(`\x1b[32m✓ Connected! ${server?.tools.length || 0} tools available\x1b[0m\r\n`);
                } catch (e: any) {
                    terminal.write(`\x1b[31m✗ Connection failed: ${e.message}\x1b[0m\r\n`);
                }
                break;
            }

            case 'disconnect': {
                const id = args[0];
                if (!id) {
                    terminal.write('\r\n\x1b[31mUsage: /mcp disconnect <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                try {
                    await registry.disconnectServer(id);
                    terminal.write(`\r\n\x1b[32m✓ Disconnected: ${id}\x1b[0m\r\n`);
                } catch (e: any) {
                    terminal.write(`\r\n\x1b[31m✗ ${e.message}\x1b[0m\r\n`);
                }
                break;
            }

            case 'list':
                showMcpStatus();
                break;

            default:
                terminal.write(`\r\n\x1b[31mUnknown /mcp subcommand: ${subcommand}\x1b[0m\r\n`);
                terminal.write('\x1b[90mAvailable: add, remove, auth, connect, disconnect, list\x1b[0m\r\n');
        }
    } catch (e: any) {
        terminal.write(`\r\n\x1b[31mError: ${e.message}\x1b[0m\r\n`);
    }

    showPrompt();
}

/**
 * Display MCP status including local and remote servers
 */
function showMcpStatus(): void {
    const registry = getRemoteMCPRegistry();
    const remoteServers = registry.getServers();

    terminal.write('\r\n\x1b[36m┌─ MCP Status ─────────────────────────\x1b[0m\r\n');
    terminal.write(`\x1b[36m│\x1b[0m Initialized: ${mcpInitialized ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}\r\n`);
    terminal.write(`\x1b[36m│\x1b[0m Agent SDK:   ${agent ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}\r\n`);

    // Local WASM MCP Server
    if (mcpServerInfo) {
        terminal.write(`\x1b[36m│\x1b[0m\r\n`);
        terminal.write(`\x1b[36m│\x1b[0m \x1b[1m📦 Local: ${mcpServerInfo.name}\x1b[0m v${mcpServerInfo.version}\r\n`);
        terminal.write(`\x1b[36m│\x1b[0m Tools (${mcpToolsList.length}):\r\n`);
        for (const tool of mcpToolsList) {
            const desc = tool.description ? ` - ${tool.description.substring(0, 40)}${tool.description.length > 40 ? '...' : ''}` : '';
            terminal.write(`\x1b[36m│\x1b[0m   \x1b[33m${tool.name}\x1b[0m\x1b[90m${desc}\x1b[0m\r\n`);
        }
    }

    // Remote MCP Servers
    if (remoteServers.length > 0) {
        terminal.write(`\x1b[36m│\x1b[0m\r\n`);
        terminal.write(`\x1b[36m│\x1b[0m \x1b[1m🌐 Remote Servers (${remoteServers.length}):\x1b[0m\r\n`);

        for (const server of remoteServers) {
            const statusIcon = getStatusIcon(server.status);
            const statusColor = getStatusColor(server.status);

            terminal.write(`\x1b[36m│\x1b[0m\r\n`);
            terminal.write(`\x1b[36m│\x1b[0m   ${statusIcon} \x1b[1m${server.name}\x1b[0m \x1b[90m(${server.id})\x1b[0m\r\n`);
            terminal.write(`\x1b[36m│\x1b[0m     URL: \x1b[90m${server.url}\x1b[0m\r\n`);
            terminal.write(`\x1b[36m│\x1b[0m     Auth: \x1b[90m${server.authType}\x1b[0m  Status: ${statusColor}${server.status}\x1b[0m\r\n`);

            if (server.error) {
                terminal.write(`\x1b[36m│\x1b[0m     \x1b[31mError: ${server.error}\x1b[0m\r\n`);
            }

            if (server.status === 'connected' && server.tools.length > 0) {
                terminal.write(`\x1b[36m│\x1b[0m     Tools (${server.tools.length}):\r\n`);
                for (const tool of server.tools.slice(0, 5)) {
                    const desc = tool.description ? ` - ${tool.description.substring(0, 30)}...` : '';
                    terminal.write(`\x1b[36m│\x1b[0m       \x1b[33m${tool.name}\x1b[0m\x1b[90m${desc}\x1b[0m\r\n`);
                }
                if (server.tools.length > 5) {
                    terminal.write(`\x1b[36m│\x1b[0m       \x1b[90m...and ${server.tools.length - 5} more\x1b[0m\r\n`);
                }
            }
        }
    } else {
        terminal.write(`\x1b[36m│\x1b[0m\r\n`);
        terminal.write(`\x1b[36m│\x1b[0m \x1b[90mNo remote servers. Use /mcp add <url> to add one.\x1b[0m\r\n`);
    }

    terminal.write('\x1b[36m└──────────────────────────────────────\x1b[0m\r\n');

    if (!agent && !ANTHROPIC_API_KEY) {
        terminal.write('\r\n\x1b[33mSet VITE_ANTHROPIC_API_KEY to enable Agent SDK\x1b[0m\r\n');
    }
}

function getStatusIcon(status: string): string {
    switch (status) {
        case 'connected': return '\x1b[32m●\x1b[0m';
        case 'connecting': return '\x1b[33m◐\x1b[0m';
        case 'auth_required': return '\x1b[33m🔒\x1b[0m';
        case 'error': return '\x1b[31m✗\x1b[0m';
        default: return '\x1b[90m○\x1b[0m';
    }
}

function getStatusColor(status: string): string {
    switch (status) {
        case 'connected': return '\x1b[32m';
        case 'connecting': return '\x1b[33m';
        case 'auth_required': return '\x1b[33m';
        case 'error': return '\x1b[31m';
        default: return '\x1b[90m';
    }
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

// ============ Input Handling (Readline-based) ============

const PROMPT = '\x1b[36m❯\x1b[0m ';

// Set up Ctrl+C handler for cancellation during agent execution
readline.setCtrlCHandler(() => {
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
        readline.println('\x1b[33m⚠ Cancelled by user\x1b[0m');
        setStatus('Ready', '#3fb950');
        debug('User cancelled execution');
    }
});

/**
 * Main prompt loop using xterm-readline
 * Provides: command history, Ctrl+U (clear line), Ctrl+K (delete to end),
 * Home/End, arrow keys for cursor movement
 */
async function promptLoop(): Promise<void> {
    while (true) {
        try {
            const input = await readline.read(PROMPT);
            if (input.trim()) {
                await sendMessage(input.trim());
            }
        } catch (e) {
            // Readline was cancelled or errored
            debug('Readline error:', e);
        }
    }
}

// Legacy showPrompt for compatibility (now triggers readline)
function showPrompt(): void {
    // Readline handles prompting, but we may need this for status updates
    // The prompt loop will automatically show the next prompt
}

// ============ Welcome ============



terminal.write('\x1b[36m╭────────────────────────────────────────────╮\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  \x1b[1mWeb Agent\x1b[0m - Browser Edition              \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  Files persist in OPFS sandbox            \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m│\x1b[0m  Type /help for commands                  \x1b[36m│\x1b[0m\r\n');
terminal.write('\x1b[36m╰────────────────────────────────────────────╯\x1b[0m\r\n');
terminal.write('\x1b[90mInitializing sandbox...\x1b[0m\r\n');

// Prompt will be shown when sandbox is ready
terminal.focus();
