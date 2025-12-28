/**
 * /mode Command
 * 
 * View or switch agent mode between normal and plan.
 */

import { CommandDef, colors } from './types';
import type { AgentMode } from '../agent/AgentMode';

// We need access to mode state - will be injected via context
let setModeCallback: ((mode: AgentMode) => void) | null = null;
let getModeCallback: (() => AgentMode) | null = null;

/**
 * Register callbacks for mode state management
 */
export function registerModeCallbacks(
    getModeFunc: () => AgentMode,
    setModeFunc: (mode: AgentMode) => void
): void {
    getModeCallback = getModeFunc;
    setModeCallback = setModeFunc;
}

export const modeCommand: CommandDef = {
    name: 'mode',
    description: 'View or switch agent mode',
    usage: '/mode [normal|plan]',
    aliases: ['m'],
    completions: (partial) => {
        const modes = ['normal', 'plan'];
        return modes
            .filter(m => m.startsWith(partial))
            .map(m => `/mode ${m}`);
    },
    handler: async (ctx, args) => {
        if (!getModeCallback || !setModeCallback) {
            ctx.output('error', 'Mode callbacks not registered', colors.red);
            return;
        }

        const currentMode = getModeCallback();

        if (!args[0]) {
            // Show current mode
            ctx.output('system', '', undefined);
            if (currentMode === 'plan') {
                ctx.output('system', '📋 Current mode: PLAN (read-only)', colors.yellow);
                ctx.output('system', '   Type "go" or "yes" after planning to execute', colors.dim);
            } else {
                ctx.output('system', '✓ Current mode: NORMAL', colors.green);
            }
            ctx.output('system', '', undefined);
            ctx.output('system', 'Available modes:', colors.cyan);
            ctx.output('system', '  /mode normal  - Full access to all tools');
            ctx.output('system', '  /mode plan    - Read-only planning mode');
            ctx.output('system', '', undefined);
            ctx.output('system', 'Keyboard shortcuts:', colors.cyan);
            ctx.output('system', '  Ctrl+P  - Toggle plan mode');
            ctx.output('system', '  Ctrl+N  - Switch to normal mode');
            return;
        }

        const targetMode = args[0].toLowerCase();

        if (targetMode !== 'normal' && targetMode !== 'plan') {
            ctx.output('error', `Unknown mode: ${args[0]}`, colors.red);
            ctx.output('system', 'Valid modes: normal, plan', colors.dim);
            return;
        }

        if (targetMode === currentMode) {
            ctx.output('system', `Already in ${targetMode.toUpperCase()} mode`, colors.dim);
            return;
        }

        // Switch mode - the setMode callback will output the confirmation
        setModeCallback(targetMode);
    },
};
