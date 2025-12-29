/**
 * /shell Command
 * 
 * Launch the interactive shell (sh) with full REPL functionality.
 * This gives you an unbuffered, raw terminal experience.
 * Exit with 'exit', Ctrl+D, or 'q' depending on the shell.
 */

import { CommandDef, colors } from './types';

// Callback for launching interactive shell - registered by App
let launchInteractiveCallback: ((moduleName: string, command: string, args: string[]) => Promise<void>) | null = null;

/**
 * Register callback for launching interactive processes
 */
export function registerShellModeCallback(
    launchInteractiveFunc: (moduleName: string, command: string, args: string[]) => Promise<void>
): void {
    launchInteractiveCallback = launchInteractiveFunc;
}

export const shellCommand: CommandDef = {
    name: 'shell',
    description: 'Launch interactive shell (full REPL)',
    usage: '/shell',
    aliases: ['sh'],
    handler: async (ctx) => {
        if (!launchInteractiveCallback) {
            ctx.output('error', 'Interactive shell callback not registered', colors.red);
            return;
        }

        ctx.output('system', '', undefined);
        ctx.output('system', '🖥️ Launching interactive shell...', colors.cyan);
        ctx.output('system', '   Press Ctrl+D or type "exit" to return to agent mode', colors.dim);
        ctx.output('system', '', undefined);

        // Launch the interactive shell
        await launchInteractiveCallback('brush-shell', 'sh', []);
    },
};
