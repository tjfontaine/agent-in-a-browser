// Web Agent TUI - Browser Edition
// Uses OPFS sandbox via WebWorker + Anthropic API

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Spinner, renderToolOutput, renderSectionHeader } from './tui';

const API_URL = 'http://localhost:3001';
const AUTH_TOKEN = 'dev-token';

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

// ============ Sandbox Worker ============

const sandbox = new Worker(new URL('./sandbox-worker.ts', import.meta.url), { type: 'module' });

// Tool definitions from worker
let tools: any[] = [];

// Pending tool calls
const pendingToolCalls = new Map<string, (result: any) => void>();

sandbox.onmessage = (event) => {
    const { type, message, tools: workerTools, id, result } = event.data;

    if (type === 'status') {
        setStatus(message, '#d29922');
    } else if (type === 'ready') {
        setStatus('Ready', '#3fb950');
        sandbox.postMessage({ type: 'get_tools' });
        showPrompt();
    } else if (type === 'tools') {
        tools = workerTools;
        console.log('Loaded tools:', tools.map((t: any) => t.name));
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
        pendingToolCalls.set(id, resolve);
        sandbox.postMessage({ type: 'call_tool', id, tool: { name, input } });
    });
}

// ============ Status Display ============

function setStatus(status: string, color = '#3fb950') {
    const el = document.getElementById('status')!;
    el.textContent = status;
    el.style.color = color;
}

// ============ Conversation State ============

type Message = { role: 'user' | 'assistant'; content: any };
const messages: Message[] = [];

const SYSTEM_PROMPT = `You are a helpful AI assistant running in a WASM sandbox.

# Tone and Style
- Keep responses short and concise for CLI output
- Use Github-flavored markdown for formatting
- No emojis unless explicitly requested
- Be direct and professional - avoid excessive praise or validation

# Available Tools

## File Operations (prefer these over shell)
- read_file: Read file contents from OPFS
- write_file: Create/overwrite files in OPFS  
- edit_file: Find and replace text in files
- list: List directory contents
- grep: Search files for patterns

## Shell Commands
- shell: Run coreutils (ls, cat, mkdir, rm, cp, mv, head, tail, wc, find, grep, sort, uniq, echo, pwd, date)

## Code Execution
- execute: Run simple JavaScript expressions
- execute_typescript: Run TypeScript with npm packages

# Using execute_typescript
TypeScript runs with esbuild + esm.sh for npm imports:
\`\`\`typescript
import _ from 'lodash';
console.log(_.chunk([1,2,3,4], 2));
\`\`\`

Node.js APIs are shimmed to use OPFS:
- fs.promises.readFile/writeFile → OPFS
- path.join/dirname/basename → work normally

# Doing Tasks
- ALWAYS read files before modifying them
- Keep solutions simple - don't over-engineer
- Make parallel tool calls when tools are independent
- Never guess missing parameters

# Environment
- Files persist in Origin Private File System (OPFS)
- OPFS logs to console with [OPFS] prefix for debugging`;

// ============ Agent Loop ============

let inputBuffer = '';
let spinner: Spinner | null = null;

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

    messages.push({ role: 'user', content: userMessage });
    await runAgentLoop();
}

function handleSlashCommand(command: string): void {
    const cmd = command.slice(1).toLowerCase();

    switch (cmd) {
        case 'clear':
            terminal.clear();
            messages.length = 0;
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
        case 'help':
            terminal.write('\r\n\x1b[36mCommands:\x1b[0m\r\n');
            terminal.write('  /clear - Clear conversation\r\n');
            terminal.write('  /files - List files in sandbox\r\n');
            terminal.write('  /help  - Show this help\r\n');
            break;
        default:
            terminal.write(`\r\n\x1b[31mUnknown command: ${command}\x1b[0m\r\n`);
    }
    showPrompt();
}

async function runAgentLoop(): Promise<void> {
    try {
        const response = await fetch(`${API_URL}/api/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify({
                messages,
                tools,
                system: SYSTEM_PROMPT,
            }),
        });

        const { content, toolCalls } = await handleSSEResponse(response);

        if (content.length > 0) {
            messages.push({ role: 'assistant', content });
        }

        if (toolCalls.length > 0) {
            if (spinner) spinner.stop();
            spinner = null;

            setStatus('Executing...', '#bc8cff');
            const toolResults: any[] = [];

            for (const tool of toolCalls) {
                const args = tool.input.path || tool.input.command || tool.input.code || '';

                // Show tool execution
                const toolSpinner = new Spinner(terminal);
                toolSpinner.start(`Running ${tool.name}...`);

                const result = await callTool(tool.name, tool.input);

                toolSpinner.stop();

                const output = result.success ? result.output : `Error: ${result.error}`;
                renderToolOutput(terminal, tool.name, args, output, result.success);

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tool.id,
                    content: output,
                });
            }

            messages.push({ role: 'user', content: toolResults });

            // Continue with another thinking spinner
            spinner = new Spinner(terminal);
            spinner.start('Thinking...');

            await runAgentLoop();
            return;
        }

        if (spinner) spinner.stop();
        spinner = null;
        showPrompt();
        setStatus('Ready', '#3fb950');
    } catch (error: any) {
        terminal.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        setStatus('Error', '#ff7b72');
        showPrompt();
    }
}

async function handleSSEResponse(response: Response): Promise<{ content: any[]; toolCalls: any[] }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const content: any[] = [];
    const toolCalls: any[] = [];
    let currentText = '';
    let firstTextReceived = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
                const event = JSON.parse(data);

                if (event.type === 'text') {
                    // Stop spinner on first text chunk
                    if (!firstTextReceived) {
                        firstTextReceived = true;
                        if (spinner) {
                            spinner.stop();
                            spinner = null;
                        }
                    }
                    currentText += event.text;
                    terminal.write(event.text.replace(/\n/g, '\r\n'));
                } else if (event.type === 'tool_use') {
                    toolCalls.push({ id: event.id, name: event.name, input: event.input });
                } else if (event.type === 'message_end' && event.content) {
                    content.push(...event.content);
                } else if (event.type === 'error') {
                    terminal.write(`\r\n\x1b[31mAPI Error: ${event.error}\x1b[0m\r\n`);
                }
            } catch {
                // Skip parse errors
            }
        }
    }

    if (currentText && content.length === 0) {
        content.push({ type: 'text', text: currentText });
    }

    return { content, toolCalls };
}

// ============ Input Handling ============

function showPrompt(): void {
    terminal.write('\r\n\x1b[36m❯\x1b[0m ');
}

terminal.onData((data) => {
    const code = data.charCodeAt(0);

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
