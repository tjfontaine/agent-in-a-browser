/**
 * Embed Demo - Task-Based AI Automation
 * 
 * Shows the WebAgent as a build tool, not a chatbot.
 * Focus on: Plan → Approve → Execute (Review mode) or auto-execute (Lucky mode)
 */

import './embed-demo.css';
import { WebAgent, type AgentEvent, type TaskInfo } from '@tjfontaine/web-agent-core';
import { initializeSandbox, fetchFromSandbox } from './agent/sandbox';
import { setTransportHandler } from '@tjfontaine/wasi-shims';

console.log('[EmbedDemo] Module loaded');


// NOTE: The agent now has a built-in system preamble in Rust (DEFAULT_PREAMBLE)
// Use `preamble` config option to ADD to it, or `preambleOverride` to replace entirely

// Example tasks
const EXAMPLES: Record<string, { icon: string; title: string; task: string }> = {
    calculator: {
        icon: '🧮',
        title: 'Calculator',
        task: 'Build a TypeScript calculator with add, subtract, multiply, divide. Test it.',
    },
    fizzbuzz: {
        icon: '🎯',
        title: 'FizzBuzz',
        task: 'Implement FizzBuzz in TypeScript for 1-20. Run it and show output.',
    },
    api: {
        icon: '🌐',
        title: 'API Call',
        task: 'Fetch a joke from https://official-joke-api.appspot.com/random_joke and display it.',
    },
    json: {
        icon: '📋',
        title: 'JSON Parser',
        task: 'Create a function that parses and pretty-prints JSON. Test with sample data.',
    },
};

// State
let agent: WebAgent | null = null;
let isRunning = false;
let mode: 'review' | 'lucky' = 'review';
let currentPlan: string = '';
let streamingText: string = '';
const createdFiles = new Map<string, string>();
const tasks = new Map<string, { info: TaskInfo; status: 'pending' | 'running' | 'done' | 'error'; startTime?: number; output?: string }>();

// DOM refs
let taskInput: HTMLTextAreaElement;
let runBtn: HTMLButtonElement;
let consoleOutput: HTMLElement;
let filesList: HTMLElement;
let filePreview: HTMLElement;
let previewFilename: HTMLElement;
let taskCards: HTMLElement;
let tasksStatus: HTMLElement;
let planSection: HTMLElement;
let planContent: HTMLElement;
let planEditor: HTMLTextAreaElement;
let editPlanBtn: HTMLButtonElement;
let approvePlanBtn: HTMLButtonElement;

/**
 * Initialize
 */
function init() {
    taskInput = document.getElementById('task-input') as HTMLTextAreaElement;
    runBtn = document.getElementById('run-btn') as HTMLButtonElement;
    consoleOutput = document.getElementById('console-output')!;
    filesList = document.getElementById('files-list')!;
    filePreview = document.getElementById('file-preview')!;
    previewFilename = document.getElementById('preview-filename')!;
    taskCards = document.getElementById('task-cards')!;
    tasksStatus = document.getElementById('tasks-status')!;
    planSection = document.getElementById('plan-section')!;
    planContent = document.getElementById('plan-content')!;
    planEditor = document.getElementById('plan-editor') as HTMLTextAreaElement;
    editPlanBtn = document.getElementById('edit-plan-btn') as HTMLButtonElement;
    approvePlanBtn = document.getElementById('approve-plan-btn') as HTMLButtonElement;

    // Provider -> model mapping
    const providerSelect = document.getElementById('provider') as HTMLSelectElement;
    const modelInput = document.getElementById('model') as HTMLInputElement;
    providerSelect.addEventListener('change', () => {
        const models: Record<string, string> = {
            anthropic: 'claude-haiku-4-5-20251001',
            openai: 'gpt-4o',
            gemini: 'gemini-2.0-flash',
        };
        modelInput.value = models[providerSelect.value] || 'gpt-4o';
    });

    // Mode toggle
    const modeToggle = document.getElementById('mode-toggle')!;
    modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            mode = btn.getAttribute('data-mode') as 'review' | 'lucky';
            console.log('[EmbedDemo] Mode changed to:', mode);
        });
    });

    // Examples
    const examplesList = document.getElementById('examples-list')!;
    for (const [, ex] of Object.entries(EXAMPLES)) {
        const btn = document.createElement('button');
        btn.className = 'example-chip';
        btn.innerHTML = `${ex.icon} ${ex.title}`;
        btn.addEventListener('click', () => {
            taskInput.value = ex.task;
            taskInput.focus();
        });
        examplesList.appendChild(btn);
    }

    // Run button
    runBtn.addEventListener('click', runTask);

    // Ctrl+Enter to run
    taskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runTask();
        }
    });

    // Clear console
    document.getElementById('clear-console')!.addEventListener('click', () => {
        consoleOutput.innerHTML = '<span class="console-hint">Output will appear here...</span>';
    });

    // Plan edit
    editPlanBtn.addEventListener('click', togglePlanEdit);
    approvePlanBtn.addEventListener('click', approvePlan);
}

/**
 * Toggle plan edit mode
 */
function togglePlanEdit() {
    const isEditing = planEditor.style.display !== 'none';
    if (isEditing) {
        // Save edits
        currentPlan = planEditor.value;
        planContent.innerHTML = formatPlan(currentPlan);
        planEditor.style.display = 'none';
        planContent.style.display = 'block';
        editPlanBtn.textContent = '✏️ Edit';
    } else {
        // Enter edit mode
        planEditor.value = currentPlan;
        planEditor.style.display = 'block';
        planContent.style.display = 'none';
        editPlanBtn.textContent = '💾 Save';
    }
}

/**
 * Format plan markdown to HTML
 */
function formatPlan(planMd: string): string {
    // Simple markdown-like formatting
    const lines = planMd.split('\n').filter(l => l.trim());
    const items = lines.map((line) => {
        const cleaned = line.replace(/^[\d]+\.\s*/, '').replace(/^[-*]\s*/, '');
        return `<li>${escapeHtml(cleaned)}</li>`;
    }).join('');
    return `<ol>${items}</ol>`;
}

/**
 * Approve plan and execute
 */
async function approvePlan() {
    planSection.style.display = 'none';
    setTasksStatus('Executing...', 'running');
    streamingText = '';

    // Clear old streaming card, create execution card
    const oldCard = document.getElementById('streaming-card');
    if (oldCard) oldCard.remove();

    if (agent) {
        log('Plan approved, executing...', 'info');

        try {
            // Send execution message with the plan context - be very explicit
            const execMessage = `You MUST implement the ENTIRE plan below. Execute each step in order using the available tools.

CRITICAL: Do NOT stop after the first step. Continue calling tools until ALL steps are complete.

Available tools: write_file, run_command, read_file

For each step:
1. Call the appropriate tool (write_file to create files, run_command to execute)
2. Move to the next step immediately after the tool completes
3. Continue until ALL steps are done

Plan to implement:
${currentPlan}

BEGIN IMPLEMENTATION NOW - start with step 1 and continue through all steps.`;

            for await (const event of agent.send(execMessage)) {
                handleEvent(event);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Execution error: ${msg}`, 'error');
            setTasksStatus('Failed', 'error');
        }
    }
}

/**
 * Add/update a task card
 */
function addOrUpdateTaskCard(id: string, name: string, status: 'pending' | 'running' | 'done' | 'error', statusText?: string, output?: string) {
    let card = document.getElementById(`task-${id}`);

    const icon = status === 'done' ? '✓' : status === 'running' ? '⏳' : status === 'error' ? '✗' : '○';
    const timeText = tasks.get(id)?.startTime ? `${((Date.now() - tasks.get(id)!.startTime!) / 1000).toFixed(1)}s` : '';

    if (!card) {
        // Remove empty state
        const empty = taskCards.querySelector('.tasks-empty');
        if (empty) empty.remove();

        card = document.createElement('div');
        card.id = `task-${id}`;
        card.className = `task-card ${status}`;
        taskCards.appendChild(card);
    } else {
        card.className = `task-card ${status}`;
    }

    card.innerHTML = `
        <div class="task-card-header">
            <div class="task-card-title">
                <span class="task-card-icon">${icon}</span>
                <span class="task-card-name">${escapeHtml(name)}</span>
            </div>
            <span class="task-card-time">${timeText}</span>
        </div>
        <div class="task-card-body">
            <div class="task-card-status">${statusText || ''}</div>
            ${output ? `<div class="task-card-output">→ ${escapeHtml(output)}</div>` : ''}
        </div>
    `;

    taskCards.scrollTop = taskCards.scrollHeight;
}

/**
 * Set tasks section status
 */
function setTasksStatus(text: string, type: 'idle' | 'running' | 'done' | 'error' = 'idle') {
    tasksStatus.textContent = text;
    tasksStatus.className = `tasks-status ${type}`;
}

/**
 * Add to console
 */
function log(text: string, type: 'info' | 'output' | 'error' = 'info') {
    const hint = consoleOutput.querySelector('.console-hint');
    if (hint) hint.remove();

    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.textContent = text;
    consoleOutput.appendChild(line);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

/**
 * Track a created file
 */
function trackFile(filename: string, content: string) {
    createdFiles.set(filename, content);
    updateFilesList();
}

/**
 * Update the files list
 */
function updateFilesList() {
    if (createdFiles.size === 0) {
        filesList.innerHTML = '<div class="files-empty">No files yet</div>';
        return;
    }

    filesList.innerHTML = '';
    for (const [filename] of createdFiles) {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <span class="file-icon">${getFileIcon(filename)}</span>
            <span class="file-name">${filename}</span>
        `;
        item.addEventListener('click', () => previewFile(filename));
        filesList.appendChild(item);
    }
}

/**
 * Preview a file
 */
function previewFile(filename: string) {
    const content = createdFiles.get(filename);
    if (content) {
        previewFilename.textContent = filename;
        filePreview.innerHTML = `<code>${escapeHtml(content)}</code>`;
    }
}

/**
 * Get file icon
 */
function getFileIcon(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'ts': case 'tsx': return '📘';
        case 'js': case 'jsx': return '📒';
        case 'json': return '📋';
        case 'md': return '📝';
        default: return '📄';
    }
}

/**
 * Display streaming content in the task cards area
 */
function displayStreamingContent(text: string) {
    // Clear empty state
    const empty = taskCards.querySelector('.tasks-empty');
    if (empty) empty.remove();

    // Get or create streaming card
    let card = document.getElementById('streaming-card');
    if (!card) {
        card = document.createElement('div');
        card.id = 'streaming-card';
        card.className = 'task-card running';
        taskCards.appendChild(card);
    }

    // Simple markdown rendering
    const html = text
        .replace(/^# (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h4>$1</h4>')
        .replace(/^(\d+)\. \*\*(.+?)\*\*/gm, '<div class="task-step"><span class="step-num">$1.</span> <strong>$2</strong></div>')
        .replace(/^ {3}- (.+)$/gm, '<div class="task-substep">• $1</div>')
        .replace(/\n/g, '<br>');

    card.innerHTML = `
        <div class="task-card-header">
            <div class="task-card-title">
                <span class="task-card-icon">⏳</span>
                <span class="task-card-name">Generating Plan</span>
            </div>
        </div>
        <div class="task-card-body streaming-output">${html}</div>
    `;

    taskCards.scrollTop = taskCards.scrollHeight;
}

/**
 * Escape HTML
 */
function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Handle an agent event
 */
function handleEvent(event: AgentEvent) {
    console.log('[EmbedDemo] Event:', event);

    switch (event.type) {
        case 'plan-generated':
            if (mode === 'review') {
                currentPlan = event.plan;
                planContent.innerHTML = formatPlan(event.plan);
                planSection.style.display = 'block';
                setTasksStatus('Awaiting approval', 'idle');
            } else {
                log('Plan generated, auto-executing...', 'info');
            }
            break;

        case 'task-start':
            tasks.set(event.task.id, {
                info: event.task,
                status: 'running',
                startTime: Date.now()
            });
            addOrUpdateTaskCard(event.task.id, event.task.name, 'running', event.task.description);
            break;

        case 'task-update': {
            const taskUpdate = tasks.get(event.update.id);
            if (taskUpdate) {
                addOrUpdateTaskCard(event.update.id, taskUpdate.info.name, 'running', event.update.status);
            }
            break;
        }

        case 'task-complete': {
            const taskComplete = tasks.get(event.result.id);
            if (taskComplete) {
                taskComplete.status = event.result.success ? 'done' : 'error';
                taskComplete.output = event.result.output;
                addOrUpdateTaskCard(
                    event.result.id,
                    taskComplete.info.name,
                    event.result.success ? 'done' : 'error',
                    event.result.success ? 'Complete' : 'Failed',
                    event.result.output
                );
            }
            break;
        }

        case 'tool-call': {
            log(`Calling tool: ${event.toolName}`, 'info');
            // Add a tool execution card
            const toolId = `tool-${Date.now()}`;
            addOrUpdateTaskCard(toolId, `🔧 ${event.toolName}`, 'running', 'Executing...');
            break;
        }

        case 'tool-result': {
            if (event.data.isError) {
                log(`Tool error: ${event.data.output}`, 'error');
            } else {
                log(`Tool ${event.data.name}: success`, 'info');
            }

            // Try to update the most recent running tool card
            const runningCards = taskCards.querySelectorAll('.task-card.running');
            const lastCard = runningCards[runningCards.length - 1];
            if (lastCard) {
                lastCard.className = event.data.isError ? 'task-card error' : 'task-card done';
                const icon = lastCard.querySelector('.task-card-icon');
                if (icon) icon.textContent = event.data.isError ? '✗' : '✓';
                const status = lastCard.querySelector('.task-card-status');
                if (status) status.textContent = event.data.isError ? 'Error' : 'Done';
            }

            // Check if tool created a file
            if (event.data.name === 'write_file' && event.data.output) {
                try {
                    const result = JSON.parse(event.data.output);
                    if (result.path) {
                        trackFile(result.path, result.content || '');
                    }
                } catch {
                    // Not JSON, try to extract filename from output
                    const match = event.data.output.match(/wrote to (.+)/i);
                    if (match) {
                        trackFile(match[1].trim(), '');
                    }
                }
            }
            break;
        }

        case 'chunk':
            // Accumulate streaming text and display in task cards
            streamingText += event.text;
            displayStreamingContent(streamingText);
            break;

        case 'complete':
            // Show final plan in review mode
            if (mode === 'review' && streamingText.includes('Plan')) {
                currentPlan = streamingText;
                planContent.innerHTML = formatPlan(streamingText);
                planSection.style.display = 'block';
            }
            setTasksStatus('Complete', 'done');
            break;

        case 'error':
            log(`Error: ${event.error}`, 'error');
            setTasksStatus('Failed', 'error');
            break;

        case 'ready':
            setTasksStatus('Complete', 'done');
            break;
    }
}

/**
 * Run the task
 */
async function runTask() {
    const task = taskInput.value.trim();
    if (!task || isRunning) return;

    const provider = (document.getElementById('provider') as HTMLSelectElement).value;
    const model = (document.getElementById('model') as HTMLInputElement).value;
    const apiKey = (document.getElementById('api-key') as HTMLInputElement).value;

    if (!apiKey) {
        setTasksStatus('Enter API key', 'error');
        return;
    }

    isRunning = true;
    runBtn.disabled = true;
    taskCards.innerHTML = '';
    tasks.clear();
    streamingText = '';
    planSection.style.display = 'none';
    setTasksStatus('Initializing...', 'running');

    try {
        // Initialize agent if needed
        if (!agent) {
            // Initialize sandbox worker first
            console.log('[EmbedDemo] Initializing sandbox...');
            await initializeSandbox();
            console.log('[EmbedDemo] Sandbox ready');

            // Set up transport handler to route MCP requests to sandbox (same as TUI)
            setTransportHandler(async (method, url, headers, body) => {
                // Extract path from URL (e.g., /mcp/message from http://localhost:3000/mcp/message)
                const urlObj = new URL(url);
                const path = urlObj.pathname;

                console.log('[EmbedDemo] MCP transport:', method, path);

                // Build fetch options
                const fetchOptions: RequestInit = { method, headers };
                if (body) {
                    fetchOptions.body = new Blob([body as BlobPart]);
                }

                // Route through sandbox worker
                const response = await fetchFromSandbox(path, fetchOptions);

                // Convert response
                const responseBody = new Uint8Array(await response.arrayBuffer());
                const responseHeaders: [string, Uint8Array][] = [];
                response.headers.forEach((value, name) => {
                    responseHeaders.push([name.toLowerCase(), new TextEncoder().encode(value)]);
                });

                return {
                    status: response.status,
                    headers: responseHeaders,
                    body: responseBody,
                };
            });
            console.log('[EmbedDemo] MCP transport handler configured');

            console.log('[EmbedDemo] Creating WebAgent', { provider, model, apiKey: '***' });
            agent = new WebAgent({
                provider,
                model,
                apiKey,
                mcpUrl: 'http://localhost:3000/mcp',
            });
            console.log('[EmbedDemo] Initializing agent...');
            await agent.initialize();
            console.log('[EmbedDemo] Agent initialized successfully');
        }

        // Prepare task with mode-specific preamble
        const preamble = mode === 'review'
            ? 'Create a numbered plan for this task. Format as:\n1. **Step name** - description\n2. **Step name** - description\n\nBe concise. After showing the plan, stop and wait for approval.'
            : 'Execute this task step by step. Show progress as you work.';

        const fullTask = `${preamble}\n\nTask: ${task}`;

        setTasksStatus('Working...', 'running');

        console.log('[EmbedDemo] Sending task to agent');
        for await (const event of agent.send(fullTask)) {
            handleEvent(event);
        }
        console.log('[EmbedDemo] Task complete');

        if (mode !== 'review' || tasks.size > 0) {
            setTasksStatus('Complete', 'done');
        }

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error: ${msg}`, 'error');
        setTasksStatus('Failed', 'error');
    } finally {
        isRunning = false;
        runBtn.disabled = false;
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
