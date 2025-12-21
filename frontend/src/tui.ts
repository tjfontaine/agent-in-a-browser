// TUI Rendering Components
// Renders diffs, plans, progress indicators using xterm.js ANSI codes

import { Terminal } from '@xterm/xterm';

// ============ Color Codes ============
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',

    // Foreground
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    // Background
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
    bgGray: '\x1b[100m',
};

// ============ Minimalist Drawing ============
const DIVIDER = '─';

export function drawBox(term: Terminal, title: string, content: string[], width = 60): void {
    // Minimalist header
    term.write(`\r\n${C.bold}${title}${C.reset}\r\n`);
    term.write(`${C.dim}${DIVIDER.repeat(title.length)}${C.reset}\r\n`);

    for (const line of content) {
        term.write(`${line}\r\n`);
    }
    term.write('\r\n');
}

// ============ Diff Block ============
export interface DiffHunk {
    oldText: string;
    newText: string;
}

export function renderDiff(term: Terminal, filePath: string, hunks: DiffHunk[]): void {
    // Header
    term.write(`\r\n${C.bold}${filePath}${C.reset}\r\n`);

    for (const hunk of hunks) {
        term.write(`${C.dim}---${C.reset}\r\n`);

        // Old lines (red -)
        const oldLines = hunk.oldText.split('\n');
        for (const line of oldLines) {
            if (line.trim()) {
                term.write(`${C.red}- ${line}${C.reset}\r\n`);
            }
        }

        // New lines (green +)
        const newLines = hunk.newText.split('\n');
        for (const line of newLines) {
            if (line.trim()) {
                term.write(`${C.green}+ ${line}${C.reset}\r\n`);
            }
        }
    }
    term.write('\r\n');
}

// ============ Interactive Prompt ============
export type PromptChoice = 'yes' | 'no' | 'edit';

export function renderPrompt(term: Terminal, question: string): void {
    term.write(`${C.bold}${question}${C.reset} ${C.dim}[y]es / [n]o / [e]dit${C.reset} `);
}

// ============ Plan Block ============
export interface PlanItem {
    text: string;
    status: 'pending' | 'running' | 'done' | 'error';
}

// Task alias for the task management feature
// Maps TaskManager status to PlanItem status
export interface TaskItem {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export function renderPlan(term: Terminal, items: PlanItem[]): void {
    term.write(`\r\n${C.bold}Plan${C.reset}\r\n`);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let icon: string;
        let color: string;

        switch (item.status) {
            case 'done':
                icon = '✓';
                color = C.green;
                break;
            case 'running':
                icon = '⠋';
                color = C.yellow;
                break;
            case 'error':
                icon = '✗';
                color = C.red;
                break;
            default:
                icon = '○';
                color = C.dim;
        }

        term.write(`${color}${icon}${C.reset} ${i + 1}. ${item.text}\r\n`);
    }
    term.write('\r\n');
}

/**
 * Render tasks from TaskManager
 * Converts TaskItem status to PlanItem status for display
 */
export function renderTasks(term: Terminal, tasks: TaskItem[]): void {
    const planItems: PlanItem[] = tasks.map(task => ({
        text: task.content,
        status: task.status === 'completed' ? 'done'
            : task.status === 'in_progress' ? 'running'
                : 'pending',
    }));
    renderPlan(term, planItems);
}

// ============ Spinner ============
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
    private term: Terminal;
    private message: string;
    private interval: ReturnType<typeof setInterval> | null = null;
    private frame = 0;

    constructor(term: Terminal) {
        this.term = term;
        this.message = '';
    }

    start(message: string): void {
        this.message = message;
        this.frame = 0;

        // Save cursor position and start spinner
        this.term.write(`\r${C.blue}${SPINNER_FRAMES[0]}${C.reset} ${this.message}`);

        this.interval = setInterval(() => {
            this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
            // Move to start of line and redraw
            this.term.write(`\r${C.blue}${SPINNER_FRAMES[this.frame]}${C.reset} ${this.message}`);
        }, 80);
    }

    update(message: string): void {
        this.message = message;
    }

    stop(finalMessage?: string): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        // Clear line and show final message
        this.term.write('\r\x1b[K'); // Clear to end of line
        if (finalMessage) {
            this.term.write(`\r${C.green}✓${C.reset} ${finalMessage}\r\n`);
        }
    }

    error(message: string): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.term.write('\r\x1b[K');
        this.term.write(`${C.red}✗${C.reset} ${message}\r\n`);
    }
}

// ============ Tool Output Block ============
export function renderToolOutput(term: Terminal, toolName: string, args: string, output: string, success: boolean): void {
    const icon = success ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;

    // Minimal header: checks, toolname, minimal args
    term.write(`\r\n${icon} ${C.bold}${toolName}${C.reset}`);
    if (args) {
        const argsDisplay = args.length > 50 ? args.substring(0, 47) + '...' : args;
        term.write(` ${C.dim}${argsDisplay}${C.reset}`);
    }
    term.write('\r\n');

    // Output - simple indentation
    if (output) {
        const lines = output.split('\n').slice(0, 10); // Max 10 lines
        const hasMore = output.split('\n').length > 10;

        for (const line of lines) {
            const displayLine = line.length > 80 ? line.substring(0, 77) + '...' : line;
            term.write(`  ${C.dim}${displayLine}${C.reset}\r\n`);
        }

        if (hasMore) {
            term.write(`  ${C.dim}... (${output.split('\n').length - 10} more lines)${C.reset}\r\n`);
        }
    }
}

// ============ Progress Bar ============
export function renderProgress(term: Terminal, current: number, total: number, label?: string): void {
    const width = 20;
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    // const percent = Math.round((current / total) * 100);

    const bar = `${'━'.repeat(filled)}${' '.repeat(empty)}`;
    term.write(`\r${C.dim}[${bar}]${C.reset}`);
    if (label) {
        term.write(` ${label}`);
    }
}

// ============ Section Header ============
export function renderSectionHeader(term: Terminal, title: string): void {
    term.write(`\r\n${C.bold}${title}${C.reset}\r\n`);
}

// ============ Thinking/Status Line ============
export function renderThinking(term: Terminal, message: string, cost?: string): void {
    term.write(`\r${C.blue}⠋${C.reset} ${message}${C.reset}`);
    if (cost) {
        term.write(` ${C.dim}(${cost})${C.reset}`);
    }
}
