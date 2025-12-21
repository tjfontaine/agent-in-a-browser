/**
 * Input Handling
 * 
 * Manages the prompt loop and input handling.
 */

import type { Readline } from 'xterm-readline';
import { PROMPT } from '../constants';
import { requestCancel, isAgentBusy } from '../agent/loop';
import { setStatus } from '../agent/status';

// ============ State ============

let _currentReadline: Readline | null = null;

// ============ Ctrl+C Handler ============

/**
 * Setup the Ctrl+C handler for cancellation.
 */
export function setupCtrlCHandler(readline: Readline): void {
    _currentReadline = readline;

    readline.setCtrlCHandler(() => {
        if (isAgentBusy()) {
            const cancelled = requestCancel();
            if (cancelled) {
                readline.println('\x1b[33m⚠ Cancelled by user\x1b[0m');
                setStatus('Ready', '#3fb950');
                console.log('[Agent] User cancelled execution');
            }
        }
    });
}

// ============ Prompt Loop ============

/**
 * Start the main prompt loop.
 * 
 * @param readline - Readline instance for input
 * @param onInput - Callback for handling user input
 */
export async function startPromptLoop(
    readline: Readline,
    onInput: (input: string) => Promise<void>
): Promise<void> {
    while (true) {
        try {
            const input = await readline.read(PROMPT);
            if (input.trim()) {
                await onInput(input.trim());
            }
        } catch (e) {
            // Readline was cancelled or errored
            console.log('[Input] Readline error:', e);
        }
    }
}

/**
 * Show prompt (legacy compatibility).
 * The prompt loop handles this automatically.
 */
export function showPrompt(): void {
    // Readline handles prompting automatically
    // This function exists for API compatibility
}
