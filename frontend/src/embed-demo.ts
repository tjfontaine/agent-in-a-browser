/**
 * Embed Demo - Live "Full Stack" Editor
 * 
 * Demonstrates the WebAgent as a generic backend runtime.
 * The generated frontend (HTML) calls back into the Agent (WASM) to execute code.
 */

import './embed-demo.css';
import { WebAgent, type AgentEvent } from '@tjfontaine/web-agent-core';
import { initializeSandbox, fetchFromSandbox } from './agent/sandbox';
import { setTransportHandler } from '@tjfontaine/wasi-shims';

console.log('[EmbedDemo] Module loaded');

// --- Configuration ---

const SYSTEM_PROMPT = `
You are an expert Full Stack Developer building a live web application in the browser.
Uniquely, you can use YOURSELF as the backend server.

The user wants you to build an app that runs logic (TypeScript, Database, etc.).
You have two roles:
1.  **Backend Developer**: Write scripts (e.g., 'backend.ts', 'db.js') that perform the heavy lifting.
2.  **Frontend Developer**: Write 'index.html' that calls these scripts using the special 'window.agent.exec()' function.

### The "Agent as Backend" Bridge
The frontend you create can execute commands in your shell using:
\`\`\`javascript
const result = await window.agent.exec('tsx backend.ts some_arg');
\`\`\`
Use this for:
- Heavy calculation (Python/TS scripts).
- Database queries (sqlite3).
- File system operations (cat, ls).

### Instructions
1.  **Plan**: Decide what backend scripts you need and how the UI will call them.
2.  **Implementation**:
    - Write the backend script first (e.g., 'logic.ts').
    - Verify it works by running it yourself: \`tsx logic.ts test\`.
    - Write the 'index.html' (and css/js) that uses \`window.agent.exec\` to call your script.
3.  **Execution**:
    - If the user sends a message starting with "EXECUTE_BACKEND_COMMAND:", DO NOT CHAT.
    - IMMEDIATELY run the requested command using 'run_command'.
    - THEN STOP.

### Constraints
- For the UI, use standard HTML/CSS.
- For the Backend, use 'tsx' (TypeScript), 'sqlite3', or standard unix tools.
- External UI libs: Use CDNs (e.g., Chart.js from cdnjs).
- DO NOT use 'npm install'.
`;

const SCENARIOS = [
    {
        icon: '🔢',
        title: 'Prime Finder',
        prompt: 'Build a "Prime Number Finder". \n1. Create a efficient backend script "primes.ts" that takes a number and checks if it is prime. \n2. Create a frontend that asks for a number, calls "tsx primes.ts <num>", and displays the result.'
    },
    {
        icon: '🗄️',
        title: 'SQLite Manager',
        prompt: 'Create a SQLite Manager. \n1. Initialize a "data.db" with a "users" table (id, name, email) and some dummy data. \n2. Create a UI that allows me to type a SQL query, executes it via "sqlite3 data.db <query>", and displays the results in a table.'
    },
    {
        icon: '🐍',
        title: 'Python (via Wasm)',
        prompt: 'Can you run Python? Create a script "calc.py" that prints the factorial of a number argument. Then build a UI to use it.'
    }
];

// --- State ---
let agent: WebAgent | null = null;
let isRunning = false;
let fileCache = new Map<string, string>();


// --- UI Classes ---

class LogManager {
    private logEl: HTMLElement;
    private termEl: HTMLElement;
    private statusEl: HTMLElement;

    constructor() {
        this.logEl = document.getElementById('activity-log')!;
        this.termEl = document.getElementById('terminal-output')!;
        this.statusEl = document.getElementById('terminal-status')!;
    }

    add(text: string, type: 'user' | 'agent' | 'error' | 'success' = 'agent') {
        const div = document.createElement('div');
        div.className = `log-item ${type}`;
        div.textContent = text;
        this.logEl.appendChild(div);
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    term(text: string, type: 'cmd' | 'out' | 'err' = 'out') {
        const div = document.createElement('div');
        // explicit class mapping to match css
        const typeClass = type === 'cmd' ? 'term-cmd' : type === 'err' ? 'term-err' : 'term-out';
        div.className = `term-line ${typeClass}`;
        div.textContent = text;
        this.termEl.appendChild(div);
        this.termEl.scrollTop = this.termEl.scrollHeight;
    }

    status(text: string) {
        this.statusEl.textContent = text;
    }
}

class LivePreview {
    private iframe: HTMLIFrameElement;
    private toast: HTMLElement;

    constructor() {
        this.iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
        this.toast = document.getElementById('toast')!;
        this.render('', '', ''); // Init

        document.getElementById('refresh-preview')?.addEventListener('click', () => this.refresh());
        document.getElementById('open-new-tab')?.addEventListener('click', () => this.openNewTab());

        // Setup Bridge Receiver in Parent
        window.addEventListener('message', this.handleMessage.bind(this));
    }

    private async handleMessage(event: MessageEvent) {
        if (!agent) return;

        if (event.data?.type === 'agent_exec') {
            const { id, cmd } = event.data;
            logger.add(`UI Request: ${cmd}`, 'user');
            logger.status('⚡ Backend Active');

            try {
                // Execute on Agent
                let output = '';
                const prompt = `EXECUTE_BACKEND_COMMAND: ${cmd}`;

                // We use a specific loop to process this "backend" request
                // We don't want to log everything to the main chat log to keep it clean,
                // but we DO want to show it in the terminal.
                for await (const e of agent.send(prompt)) {
                    if (e.type === 'tool-result' && e.data.name === 'run_command') {
                        output += (e.data.isError ? e.data.output : e.data.output) || '';
                        if (e.data.isError) logger.term(e.data.output, 'err');
                        else logger.term(e.data.output, (e.data.isError ? 'err' : 'out'));
                    }
                    if (e.type === 'tool-call') {
                        logger.term(`$ BE: ${e.toolName}`, 'cmd');
                    }
                }

                // Send response back to Iframe
                if (this.iframe.contentWindow) {
                    this.iframe.contentWindow.postMessage({
                        type: 'agent_result',
                        id,
                        success: true,
                        result: output.trim()
                    }, '*');
                }
                logger.status('Idle');

            } catch (err: any) {
                console.error('Agent Exec Error:', err);
                if (this.iframe.contentWindow) {
                    this.iframe.contentWindow.postMessage({
                        type: 'agent_result',
                        id,
                        success: false,
                        error: err.toString()
                    }, '*');
                }
            }
        }
    }

    update(filename: string, content: string) {
        fileCache.set(filename, content);
        this.refresh();
        this.showToast(`Updated ${filename}`);
    }

    refresh() {
        const html = fileCache.get('index.html') || '<!-- Waiting for index.html... -->';
        const css = fileCache.get('style.css') || '';
        const js = fileCache.get('script.js') || '';
        this.render(html, css, js);
    }

    private render(html: string, css: string, js: string) {
        const doc = this.iframe.contentDocument;
        if (!doc) return;

        //Client-side Shim for the Agent Bridge
        const agentShim = `
            window.agent = {
                exec: function(cmd) {
                    return new Promise((resolve, reject) => {
                        const id = Math.random().toString(36).substring(7);
                        const handle = (e) => {
                            if (e.data?.type === 'agent_result' && e.data.id === id) {
                                window.removeEventListener('message', handle);
                                if (e.data.success) resolve(e.data.result);
                                else reject(new Error(e.data.error));
                            }
                        };
                        window.addEventListener('message', handle);
                        window.parent.postMessage({ type: 'agent_exec', id, cmd }, '*');
                    });
                }
            };
        `;

        doc.open();
        doc.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    /* Base styles for demo apps */
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #333; }
                    ${css}
                </style>
                <script>
                    ${agentShim}
                </script>
            </head>
            <body>
                ${html}
                <script>
                    try {
                        ${js}
                    } catch (e) {
                        document.body.innerHTML += '<div style="color:red; margin-top:20px">Script Error: ' + e.message + '</div>';
                    }
                </script>
            </body>
            </html>
        `);
        doc.close();
    }

    private showToast(msg: string) {
        this.toast.textContent = msg;
        this.toast.classList.remove('hidden');
        setTimeout(() => this.toast.classList.add('hidden'), 3000);
    }

    private openNewTab() {
        // Warning: new tab won't have the bridge access because 'window.parent' is lost
        alert("Note: Agent Bridge features won't work in a detached tab.");
        const html = fileCache.get('index.html') || '';
        const css = fileCache.get('style.css') || '';
        const js = fileCache.get('script.js') || '';

        const fullContent = `<html><head><style>${css}</style></head><body>${html}<script>/* Agent Bridge Missing */ \n ${js}</script></body></html>`;
        const blob = new Blob([fullContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    }
}

// --- Main Logic ---

const logger = new LogManager();
const preview = new LivePreview();

async function init() {
    // Buttons
    const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
    const taskInput = document.getElementById('task-input') as HTMLTextAreaElement;

    // Scenarios
    const list = document.getElementById('examples-list')!;
    if (list) {
        list.innerHTML = ''; // clear loading state
        SCENARIOS.forEach(sc => {
            const btn = document.createElement('button');
            btn.className = 'example-chip';
            btn.innerHTML = `${sc.icon} ${sc.title}`;
            btn.onclick = () => {
                taskInput.value = sc.prompt;
                taskInput.focus();
            };
            list.appendChild(btn);
        });
    }

    // Run Handler
    const handleRun = async () => {
        const text = taskInput.value.trim();
        if (!text || isRunning) return;

        // Config
        const provider = (document.getElementById('provider') as HTMLSelectElement).value;
        const apiKey = (document.getElementById('api-key') as HTMLInputElement).value;

        if (!apiKey) {
            logger.add('Please enter an API Key first.', 'error');
            return;
        }

        isRunning = true;
        runBtn.disabled = true;
        logger.add(text, 'user');
        taskInput.value = '';

        try {
            if (!agent) {
                await initAgent(provider, apiKey);
            }

            logger.add('Agent working...', 'agent');

            // Build full prompt
            const prompt = text;

            for await (const event of agent!.send(prompt)) {
                await handleEvent(event);
            }

            logger.add('Task complete.', 'success');

        } catch (e: any) {
            logger.add(`Error: ${e.message}`, 'error');
        } finally {
            isRunning = false;
            runBtn.disabled = false;
        }
    };

    runBtn.onclick = handleRun;
    taskInput.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleRun();
        }
    };
}

async function initAgent(provider: string, apiKey: string) {
    logger.add('Initializing environment...', 'agent');

    // Sandbox
    await initializeSandbox();

    // Transport
    setTransportHandler(async (method, url, headers, body) => {
        const path = new URL(url).pathname;
        const fetchOptions: RequestInit = { method, headers };
        if (body) fetchOptions.body = new Blob([body as BlobPart]);

        const res = await fetchFromSandbox(path, fetchOptions);
        const resBody = new Uint8Array(await res.arrayBuffer());
        const resHeaders: [string, Uint8Array][] = [];
        res.headers.forEach((v, k) => resHeaders.push([k.toLowerCase(), new TextEncoder().encode(v)]));

        return { status: res.status, headers: resHeaders, body: resBody };
    });

    // Agent
    // Auto-select model based on provider
    const models: Record<string, string> = {
        anthropic: 'claude-haiku-4-5-20251001',
        openai: 'o3-mini', // "Fast" option
        gemini: 'gemini-2.0-flash',
    };
    const model = models[provider] || 'gpt-4o';

    agent = new WebAgent({
        provider,
        model,
        apiKey,
        preambleOverride: SYSTEM_PROMPT,
        mcpServers: [{ url: 'http://localhost:3000/mcp', name: 'sandbox' }],
        maxTurns: 50 // Need many turns for verifying backend scripts and iterative coding
    });

    await agent.initialize();
    logger.add(`Agent ready (${provider}/${model}).`, 'success');
}

/**
 * Handle incoming agent events (during main loop)
 */
async function handleEvent(event: AgentEvent) {

    if (event.type === 'tool-call') {
        const toolName = event.toolName;
        // Arguments are NOT available in this event type
        if (toolName !== 'write_file') {
            logger.term(`Running ${toolName}...`, 'out');
        } else {
            logger.term(`Writing file...`, 'out'); // We don't know name yet
        }
    }

    if (event.type === 'tool-result') {
        if (event.data.isError) {
            logger.term(`Error: ${event.data.output}`, 'err');
        } else if (event.data.name === 'run_command') {
            logger.term(event.data.output, 'out');
        } else if (event.data.name === 'write_file') {
            // SYNC FILES!
            // We just wrote a file. We don't know WHICH one from the event args (missing),
            // but we can assume we should sync the project files.
            logger.term(event.data.output, 'out');
            await syncProjectFiles();
        }
    }
}

async function syncProjectFiles() {
    // Attempt to fetch standard files from sandbox
    const files = ['index.html', 'style.css', 'script.js'];
    for (const f of files) {
        try {
            const res = await fetchFromSandbox(f);
            if (res.ok) {
                const text = await res.text();
                // Check if changed? For now just blindly update cache
                if (fileCache.get(f) !== text) {
                    preview.update(f, text);
                }
            }
        } catch (e) {
            // ignore missing files
        }
    }
}

// Boot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
