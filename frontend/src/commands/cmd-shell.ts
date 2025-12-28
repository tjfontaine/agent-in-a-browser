/**
 * /shell Command
 * 
 * Enter direct shell mode for raw command execution.
 * In shell mode, input goes directly to the WASM shell without AI processing.
 * Exit with 'exit', 'logout', or Ctrl+D.
 */

import { CommandDef, colors } from './types';
import type { AgentMode } from '../agent/AgentMode';

// Callback for mode switching - registered by App
let setModeCallback: ((mode: AgentMode) => void) | null = null;

/**
 * Register callback for mode state management
 */
export function registerShellModeCallback(
    setModeFunc: (mode: AgentMode) => void
): void {
    setModeCallback = setModeFunc;
}

export const shellCommand: CommandDef = {
    name: 'shell',
    description: 'Enter direct shell mode (no AI processing)',
    usage: '/shell',
    aliases: ['sh'],
    handler: async (ctx) => {
        if (!setModeCallback) {
            ctx.output('error', 'Shell mode callbacks not registered', colors.red);
            return;
        }

        ctx.output('system', '', undefined);
        ctx.output('system', '💻 Entering shell mode', colors.green);
        ctx.output('system', '   Commands execute directly in the WASM shell', colors.dim);
        ctx.output('system', '   Type "exit" or press Ctrl+D to return to agent mode', colors.dim);
        ctx.output('system', '', undefined);

        // Switch to shell mode
        setModeCallback('shell');
    },
};
