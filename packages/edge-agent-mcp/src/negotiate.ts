/**
 * Generate MCP `instructions` text based on mode and connection state.
 *
 * The instructions field in the `initialize` response guides interactive
 * LLM clients (like Claude Code) through setup and usage.
 */

import type { Mode } from './config.js';

interface NegotiateOptions {
    mode: Mode;
    sessionUrl: string;
    browserConnected: boolean;
}

/**
 * Generate the instructions text for an MCP `initialize` response.
 */
export function generateInstructions(options: NegotiateOptions): string {
    const { mode, sessionUrl, browserConnected } = options;

    if (mode === 'headless') {
        return [
            'Edge Agent sandbox running locally (headless).',
            'All tools available: shell_eval, read_file, write_file, grep, edit_file, list',
            'Working directory: ~/.edge-agent/sandbox',
        ].join('\n');
    }

    if (browserConnected) {
        return [
            `Edge Agent sandbox connected at ${sessionUrl}`,
            'Available: shell (50+ POSIX commands), filesystem, TypeScript, SQLite',
            "All execution happens in the user's browser — no data leaves their machine.",
        ].join('\n');
    }

    return [
        `You are connected to Edge Agent at ${sessionUrl} — a browser sandbox with shell, filesystem, TypeScript, and SQLite.`,
        '',
        'Status: browser sandbox not connected.',
        `Ask the user to open ${sessionUrl} in their browser.`,
        'Once loaded, all tools become available.',
        'The sandbox runs entirely client-side — no data leaves their machine.',
    ].join('\n');
}

/**
 * Generate a guided error message for tool calls when browser is disconnected.
 */
export function generateDisconnectedToolError(sessionUrl: string): string {
    return [
        'Browser sandbox not connected.',
        `Ask the user to open ${sessionUrl} in their browser.`,
        'The sandbox runs entirely client-side — once they open the page, tools will be available.',
    ].join('\n');
}
