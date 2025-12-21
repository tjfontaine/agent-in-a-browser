/**
 * Welcome Banner
 * 
 * Displays the welcome message when the application starts.
 */

import { Terminal } from '@xterm/xterm';

/**
 * Display the welcome banner in the terminal.
 */
export function showWelcome(term: Terminal): void {
    term.write('\x1b[36m╭────────────────────────────────────────────╮\x1b[0m\r\n');
    term.write('\x1b[36m│\x1b[0m  \x1b[1mWeb Agent\x1b[0m - Browser Edition              \x1b[36m│\x1b[0m\r\n');
    term.write('\x1b[36m│\x1b[0m  Files persist in OPFS sandbox            \x1b[36m│\x1b[0m\r\n');
    term.write('\x1b[36m│\x1b[0m  Type /help for commands                  \x1b[36m│\x1b[0m\r\n');
    term.write('\x1b[36m╰────────────────────────────────────────────╯\x1b[0m\r\n');
    term.write('\x1b[90mInitializing sandbox...\x1b[0m\r\n');
}
