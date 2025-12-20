// TUI Rendering Components for Claude Code Browser Edition
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

// ============ Box Drawing ============
const BOX = {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
};

export function drawBox(term: Terminal, title: string, content: string[], width = 60): void {
    const titleLine = `${BOX.topLeft}${BOX.horizontal} ${title} ${BOX.horizontal.repeat(Math.max(0, width - title.length - 5))}${BOX.topRight}`;

    term.write(`${C.cyan}${titleLine}${C.reset}\r\n`);

    for (const line of content) {
        const trimmedLine = line.length > width - 4 ? line.substring(0, width - 7) + '...' : line;
        const padding = ' '.repeat(Math.max(0, width - 2 - trimmedLine.length));
        term.write(`${C.cyan}${BOX.vertical}${C.reset} ${trimmedLine}${padding}${C.cyan}${BOX.vertical}${C.reset}\r\n`);
    }

    const bottomLine = `${BOX.bottomLeft}${BOX.horizontal.repeat(width - 2)}${BOX.bottomRight}`;
    term.write(`${C.cyan}${bottomLine}${C.reset}\r\n`);
}

// ============ Diff Block ============
export interface DiffHunk {
    oldText: string;
    newText: string;
}

export function renderDiff(term: Terminal, filePath: string, hunks: DiffHunk[]): void {
    const width = 60;

    // Header
    term.write(`\r\n${C.cyan}${BOX.topLeft}${BOX.horizontal} ${filePath} ${BOX.horizontal.repeat(Math.max(0, width - filePath.length - 5))}${BOX.topRight}${C.reset}\r\n`);

    for (const hunk of hunks) {
        // Old lines (red -)
        const oldLines = hunk.oldText.split('\n');
        for (const line of oldLines) {
            if (line.trim()) {
                term.write(`${C.cyan}${BOX.vertical}${C.reset} ${C.red}-  ${line.substring(0, width - 8)}${C.reset}\r\n`);
            }
        }

        // New lines (green +)
        const newLines = hunk.newText.split('\n');
        for (const line of newLines) {
            if (line.trim()) {
                term.write(`${C.cyan}${BOX.vertical}${C.reset} ${C.green}+  ${line.substring(0, width - 8)}${C.reset}\r\n`);
            }
        }
    }

    // Footer
    term.write(`${C.cyan}${BOX.bottomLeft}${BOX.horizontal.repeat(width - 2)}${BOX.bottomRight}${C.reset}\r\n`);
}

// ============ Interactive Prompt ============
export type PromptChoice = 'yes' | 'no' | 'edit';

export function renderPrompt(term: Terminal, question: string): void {
    term.write(`${C.yellow}${question}${C.reset} ${C.dim}[y]es / [n]o / [e]dit${C.reset} `);
}

// ============ Plan Block ============
export interface PlanItem {
    text: string;
    status: 'pending' | 'running' | 'done' | 'error';
}

export function renderPlan(term: Terminal, items: PlanItem[]): void {
    term.write(`\r\n${C.cyan}${BOX.topLeft}${BOX.horizontal} Plan ${BOX.horizontal.repeat(53)}${BOX.topRight}${C.reset}\r\n`);

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
                icon = ' ';
                color = C.gray;
        }

        const text = item.text.length > 50 ? item.text.substring(0, 47) + '...' : item.text;
        const padding = ' '.repeat(Math.max(0, 50 - text.length));
        term.write(`${C.cyan}${BOX.vertical}${C.reset} ${color}[${icon}]${C.reset} ${i + 1}. ${color}${text}${C.reset}${padding}${C.cyan}${BOX.vertical}${C.reset}\r\n`);
    }

    term.write(`${C.cyan}${BOX.bottomLeft}${BOX.horizontal.repeat(58)}${BOX.bottomRight}${C.reset}\r\n`);
}

// ============ Spinner ============
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
    private term: Terminal;
    private message: string;
    private interval: ReturnType<typeof setInterval> | null = null;
    private frame = 0;
    private lineStart = 0;

    constructor(term: Terminal) {
        this.term = term;
        this.message = '';
    }

    start(message: string): void {
        this.message = message;
        this.frame = 0;

        // Save cursor position and start spinner
        this.term.write(`\r${C.yellow}${SPINNER_FRAMES[0]}${C.reset} ${C.dim}${message}${C.reset}`);

        this.interval = setInterval(() => {
            this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
            // Move to start of line and redraw
            this.term.write(`\r${C.yellow}${SPINNER_FRAMES[this.frame]}${C.reset} ${C.dim}${this.message}${C.reset}`);
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
            this.term.write(`${C.green}✓${C.reset} ${finalMessage}\r\n`);
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
    const argsDisplay = args.length > 40 ? args.substring(0, 37) + '...' : args;

    term.write(`\r\n${icon} ${C.cyan}${toolName}${C.reset}`);
    if (argsDisplay) {
        term.write(` ${C.dim}${argsDisplay}${C.reset}`);
    }
    term.write('\r\n');

    // Output in a subtle box
    if (output) {
        const lines = output.split('\n').slice(0, 10); // Max 10 lines
        const hasMore = output.split('\n').length > 10;

        for (const line of lines) {
            const displayLine = line.length > 70 ? line.substring(0, 67) + '...' : line;
            const color = success ? C.dim : C.red;
            term.write(`  ${color}${displayLine}${C.reset}\r\n`);
        }

        if (hasMore) {
            term.write(`  ${C.dim}... (${output.split('\n').length - 10} more lines)${C.reset}\r\n`);
        }
    }
}

// ============ Progress Bar ============
export function renderProgress(term: Terminal, current: number, total: number, label?: string): void {
    const width = 30;
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const percent = Math.round((current / total) * 100);

    const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
    term.write(`\r${C.cyan}[${bar}]${C.reset} ${percent}%`);
    if (label) {
        term.write(` ${C.dim}${label}${C.reset}`);
    }
}

// ============ Section Header ============
export function renderSectionHeader(term: Terminal, title: string): void {
    term.write(`\r\n${C.bold}${C.cyan}── ${title} ──${C.reset}\r\n`);
}

// ============ Thinking/Status Line ============
export function renderThinking(term: Terminal, message: string, cost?: string): void {
    term.write(`\r${C.yellow}⠋${C.reset} ${C.dim}${message}${C.reset}`);
    if (cost) {
        term.write(` ${C.gray}(${cost})${C.reset}`);
    }
}
