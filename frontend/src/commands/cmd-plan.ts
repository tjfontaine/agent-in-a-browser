/**
 * /plan Command
 * 
 * Enters plan mode for structured implementation planning.
 * In plan mode, the agent operates read-only and generates a plan file.
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

export const planCommand: CommandDef = {
    name: 'plan',
    description: 'Enter plan mode for structured implementation planning',
    usage: '/plan [description]',
    handler: async (ctx, args) => {
        const description = args.join(' ');

        if (!setModeCallback) {
            ctx.output('error', 'Mode callbacks not registered', colors.red);
            return;
        }

        // Check if already in plan mode
        if (getModeCallback?.() === 'plan') {
            if (description) {
                // If already in plan mode with description, start planning
                ctx.output('system', `📋 Planning: ${description}`, colors.yellow);
                ctx.sendMessage(`[PLAN MODE] Create a detailed implementation plan for: ${description}\n\nWrite the plan to /plan.md`);
            } else {
                ctx.output('system', 'Already in PLAN MODE', colors.yellow);
                ctx.output('system', '  /mode normal - Switch to normal mode', colors.dim);
                ctx.output('system', '  /plan <description> - Start planning a specific task', colors.dim);
            }
            return;
        }

        // Switch to plan mode
        setModeCallback('plan');

        if (description) {
            // If description provided, start planning immediately
            ctx.output('system', `📋 Planning: ${description}`, colors.yellow);
            // Send the planning request to the agent
            ctx.sendMessage(`[PLAN MODE] Create a detailed implementation plan for: ${description}\n\nWrite the plan to /plan.md`);
        }
    },
};
