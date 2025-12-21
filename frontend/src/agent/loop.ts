/**
 * Agent Execution Loop
 * 
 * Manages agent initialization and query execution.
 */

import { Terminal } from '@xterm/xterm';
import { WasmAgent } from '../agent-sdk';
import { Spinner, renderToolOutput } from '../tui';
import { setStatus } from './status';
import { isMcpInitialized } from '../commands/mcp';
import { API_URL, ANTHROPIC_API_KEY } from '../constants';
import { SYSTEM_PROMPT } from '../system-prompt';

// ============ State ============

let agent: WasmAgent | null = null;
let spinner: Spinner | null = null;
let cancelRequested = false;
let abortController: AbortController | null = null;

// ============ Debug Logging ============

/**
 * Debug logging - goes to browser console.
 */
function debug(...args: any[]): void {
    console.log('[Agent]', new Date().toISOString().slice(11, 23), ...args);
}

// ============ Initialization ============

/**
 * Initialize the agent with the WASM MCP server.
 */
export function initializeAgent(): void {
    agent = new WasmAgent({
        model: 'claude-sonnet-4-5',
        baseURL: API_URL,
        apiKey: ANTHROPIC_API_KEY,
        systemPrompt: SYSTEM_PROMPT,
        maxSteps: 15,
    });
}

/**
 * Get the current agent instance.
 */
export function getAgent(): WasmAgent | null {
    return agent;
}

/**
 * Clear agent conversation history.
 */
export function clearAgentHistory(): void {
    agent?.clearHistory();
}

// ============ Cancellation ============

/**
 * Request cancellation of the current agent execution.
 */
export function requestCancel(): boolean {
    if (spinner || abortController) {
        cancelRequested = true;
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        if (spinner) {
            spinner.stop('Cancelled');
            spinner = null;
        }
        return true;
    }
    return false;
}

/**
 * Check if agent is currently busy.
 */
export function isAgentBusy(): boolean {
    return spinner !== null || abortController !== null;
}

// ============ Message Sending ============

/**
 * Send a message to the agent.
 */
export async function sendMessage(
    term: Terminal,
    userMessage: string,
    onSlashCommand: (input: string) => void,
    showPrompt: () => void
): Promise<void> {
    // Handle slash commands
    if (userMessage.startsWith('/')) {
        onSlashCommand(userMessage);
        return;
    }

    setStatus('Thinking...', '#d29922');
    term.write('\r\n');

    // Start spinner
    spinner = new Spinner(term);
    spinner.start('Thinking...');
    cancelRequested = false;
    abortController = new AbortController();

    debug('User message:', userMessage);
    await runAgentLoop(term, userMessage, showPrompt);
}

// ============ Agent Loop ============

/**
 * Run the agent loop for a user message.
 */
async function runAgentLoop(
    term: Terminal,
    userMessage: string,
    showPrompt: () => void
): Promise<void> {
    // Check if cancelled before making API call
    if (cancelRequested) {
        debug('Agent loop cancelled');
        return;
    }

    if (!agent || !isMcpInitialized()) {
        term.write(`\r\n\x1b[31mError: Agent not initialized. Please wait for MCP to initialize.\x1b[0m\r\n`);
        if (spinner) spinner.stop();
        spinner = null;
        showPrompt();
        setStatus('Error', '#ff7b72');
        return;
    }

    await runAgentLoopWithSDK(term, userMessage, showPrompt);
}

/**
 * Run the agent loop using the Vercel AI SDK.
 */
async function runAgentLoopWithSDK(
    term: Terminal,
    userMessage: string,
    showPrompt: () => void
): Promise<void> {
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
                term.write(text.replace(/\n/g, '\r\n'));
            },
            onToolCall: (name, input) => {
                // Show tool execution spinner
                const args = (input as any).path || (input as any).command || (input as any).code || '';
                const argsDisplay = typeof args === 'string'
                    ? (args.length > 30 ? args.substring(0, 27) + '...' : args)
                    : '';
                state.toolSpinner = new Spinner(term);
                state.toolSpinner.start(`${name} ${argsDisplay} `);
                setStatus('Executing...', '#bc8cff');
            },
            onToolResult: (name, result, success) => {
                // Stop tool spinner and show result
                if (state.toolSpinner) {
                    state.toolSpinner.stop();
                    state.toolSpinner = null;
                }

                // task_write updates TaskPanel automatically via TaskManager subscription
                // Just show a minimal confirmation for it, full output for other tools
                if (name === 'task_write' && success) {
                    // TaskPanel already updated - just log
                    debug('task_write completed, TaskPanel updated');
                } else {
                    renderToolOutput(term, name, '', result, success);
                }
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
                    term.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
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
        term.write(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        setStatus('Error', '#ff7b72');
        abortController = null;
        showPrompt();
    }
}
