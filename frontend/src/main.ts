import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const API_URL = 'http://localhost:3001';
const AUTH_TOKEN = 'dev-token';
const SESSION_ID = crypto.randomUUID();

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
    const { type, id, output } = event.data;
    if (type === 'ready') {
        console.log('Shell worker ready');
    } else if (type === 'result') {
        const resolve = pendingCommands.get(id);
        if (resolve) {
            resolve(output);
            pendingCommands.delete(id);
        }
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

// Agent loop
let inputBuffer = '';

async function sendMessage(message: string) {
    setStatus('Thinking...', '#facc15');
    terminal.write('\r\n');

    try {
        const response = await fetch(`${API_URL}/api/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify({ sessionId: SESSION_ID, message }),
        });

        await handleSSEResponse(response);
    } catch (error: any) {
        terminal.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        setStatus('Error', '#ef4444');
    }
}

async function continueWithToolResults(toolResults: Array<{ tool_use_id: string; output: string }>) {
    setStatus('Thinking...', '#facc15');

    try {
        const response = await fetch(`${API_URL}/api/messages/continue`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify({ sessionId: SESSION_ID, toolResults }),
        });

        await handleSSEResponse(response);
    } catch (error: any) {
        terminal.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        setStatus('Error', '#ef4444');
    }
}

async function handleSSEResponse(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls: Array<{ id: string; name: string; input: any }> = [];

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
                    // Stream text to terminal with word wrap
                    const text = event.text.replace(/\n/g, '\r\n');
                    terminal.write(text);
                } else if (event.type === 'tool_use') {
                    pendingToolCalls.push({ id: event.id, name: event.name, input: event.input });
                    terminal.write(`\r\n\x1b[36m⚡ Tool: ${event.name}\x1b[0m\r\n`);
                    terminal.write(`\x1b[90m$ ${event.input.command}\x1b[0m\r\n`);
                } else if (event.type === 'message_end') {
                    if (event.stop_reason === 'tool_use' && pendingToolCalls.length > 0) {
                        // Execute tools
                        setStatus('Executing...', '#9d4edd');
                        const results: Array<{ tool_use_id: string; output: string }> = [];

                        for (const tool of pendingToolCalls) {
                            if (tool.name === 'shell') {
                                const output = await executeShellCommand(tool.input.command);
                                terminal.write(`\x1b[32m${output || '(no output)'}\x1b[0m\r\n`);
                                results.push({ tool_use_id: tool.id, output: output || '(command completed with no output)' });
                            }
                        }

                        // Continue with results
                        await continueWithToolResults(results);
                        return;
                    }
                } else if (event.type === 'error') {
                    terminal.write(`\r\n\x1b[31mAPI Error: ${event.error}\x1b[0m\r\n`);
                }
            } catch (e) {
                // Skip parse errors for partial data
            }
        }
    }

    // Done
    showPrompt();
    setStatus('Ready', '#4ade80');
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
terminal.write('\x1b[35m│\x1b[0m  Type a message to chat with Claude     \x1b[35m│\x1b[0m\r\n');
terminal.write('\x1b[35m│\x1b[0m  Shell commands run in browser sandbox  \x1b[35m│\x1b[0m\r\n');
terminal.write('\x1b[35m╰─────────────────────────────────────────╯\x1b[0m\r\n');
showPrompt();
terminal.focus();
