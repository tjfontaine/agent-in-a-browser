import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const API_URL = 'http://localhost:3001';
const AUTH_TOKEN = 'dev-token';

// Tool definitions - exposed to Claude from the browser
const TOOLS = [
    {
        name: 'shell',
        description: 'Execute a shell command using Bash in a browser sandbox. Has full Unix coreutils: ls, cat, grep, head, tail, sed, awk, etc. The /workspace directory persists during the session.',
        input_schema: {
            type: 'object' as const,
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute',
                },
            },
            required: ['command'],
        },
    },
];

const SYSTEM_PROMPT = `You are an AI assistant running in a browser sandbox. You have access to a shell tool that executes commands in an ephemeral filesystem. Use it to help users with file operations. Be concise.`;

// Initialize terminal
const terminal = new Terminal({
    theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#9d4edd',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#9d4edd44',
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

// Initialize shell worker
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

const pendingCommands = new Map<string, (output: string) => void>();

worker.onmessage = (event) => {
    const { type, id, output, message } = event.data;
    if (type === 'ready') {
        console.log('Bash shell ready');
        setStatus('Ready', '#4ade80');
    } else if (type === 'status') {
        console.log('Worker status:', message);
        setStatus(message, '#facc15');
    } else if (type === 'result') {
        const resolve = pendingCommands.get(id);
        if (resolve) {
            resolve(output);
            pendingCommands.delete(id);
        }
    } else if (type === 'error') {
        console.error('Worker error:', message);
        setStatus('Error', '#ef4444');
    }
};

async function executeShellCommand(command: string): Promise<string> {
    return new Promise((resolve) => {
        const id = crypto.randomUUID();
        pendingCommands.set(id, resolve);
        worker.postMessage({ type: 'execute', id, command });
    });
}

// Status display
function setStatus(status: string, color = '#4ade80') {
    const el = document.getElementById('status')!;
    el.textContent = status;
    el.style.color = color;
}

// Conversation state (managed in browser)
type Message = { role: 'user' | 'assistant'; content: any };
const messages: Message[] = [];

// Agent loop
let inputBuffer = '';

async function sendMessage(userMessage: string) {
    setStatus('Thinking...', '#facc15');
    terminal.write('\r\n');

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    await runAgentLoop();
}

async function runAgentLoop() {
    try {
        const response = await fetch(`${API_URL}/api/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify({
                messages,
                tools: TOOLS,
                system: SYSTEM_PROMPT,
            }),
        });

        const { content, toolCalls } = await handleSSEResponse(response);

        // Save assistant message
        if (content.length > 0) {
            messages.push({ role: 'assistant', content });
        }

        // Handle tool calls
        if (toolCalls.length > 0) {
            setStatus('Executing...', '#9d4edd');
            const toolResults: any[] = [];

            for (const tool of toolCalls) {
                if (tool.name === 'shell') {
                    const output = await executeShellCommand(tool.input.command);
                    terminal.write(`\x1b[32m${output || '(no output)'}\x1b[0m\r\n`);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tool.id,
                        content: output || '(command completed with no output)',
                    });
                }
            }

            // Add tool results to conversation and continue
            messages.push({ role: 'user', content: toolResults });
            await runAgentLoop();
            return;
        }

        // Done - show prompt
        showPrompt();
        setStatus('Ready', '#4ade80');
    } catch (error: any) {
        terminal.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        setStatus('Error', '#ef4444');
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
                    currentText += event.text;
                    const text = event.text.replace(/\n/g, '\r\n');
                    terminal.write(text);
                } else if (event.type === 'tool_use') {
                    toolCalls.push({ id: event.id, name: event.name, input: event.input });
                    terminal.write(`\r\n\x1b[36m⚡ Tool: ${event.name}\x1b[0m\r\n`);
                    terminal.write(`\x1b[90m$ ${event.input.command}\x1b[0m\r\n`);
                } else if (event.type === 'message_end') {
                    // Use the full content from the message
                    if (event.content) {
                        content.push(...event.content);
                    }
                } else if (event.type === 'error') {
                    terminal.write(`\r\n\x1b[31mAPI Error: ${event.error}\x1b[0m\r\n`);
                }
            } catch (e) {
                // Skip parse errors for partial data
            }
        }
    }

    // If we collected text but didn't get content from message_end, add it
    if (currentText && content.length === 0) {
        content.push({ type: 'text', text: currentText });
    }

    return { content, toolCalls };
}

function showPrompt() {
    terminal.write('\r\n\x1b[35m❯\x1b[0m ');
}

// Handle terminal input
terminal.onData((data) => {
    const code = data.charCodeAt(0);

    if (code === 13) {
        // Enter
        if (inputBuffer.trim()) {
            sendMessage(inputBuffer.trim());
        } else {
            showPrompt();
        }
        inputBuffer = '';
    } else if (code === 127) {
        // Backspace
        if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            terminal.write('\b \b');
        }
    } else if (code >= 32) {
        // Printable characters
        inputBuffer += data;
        terminal.write(data);
    }
});

// Welcome message
terminal.write('\x1b[35m╭─────────────────────────────────────────╮\x1b[0m\r\n');
terminal.write('\x1b[35m│\x1b[0m  \x1b[1mWeb Agent\x1b[0m - Browser-based Claude       \x1b[35m│\x1b[0m\r\n');
terminal.write('\x1b[35m│\x1b[0m  Bash shell runs in WASM sandbox        \x1b[35m│\x1b[0m\r\n');
terminal.write('\x1b[35m│\x1b[0m  Type a message to chat with Claude     \x1b[35m│\x1b[0m\r\n');
terminal.write('\x1b[35m╰─────────────────────────────────────────╯\x1b[0m\r\n');
showPrompt();
terminal.focus();
