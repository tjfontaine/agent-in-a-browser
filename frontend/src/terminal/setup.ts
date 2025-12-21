/**
 * Terminal Setup
 * 
 * Configures and initializes the xterm.js terminal with all addons.
 */

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Readline } from 'xterm-readline';

// ============ Terminal Configuration ============

export const terminal = new Terminal({
    theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f7866',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
    },
    fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace",
    fontSize: 14,
    cursorBlink: true,
});

// ============ Addons ============

export const fitAddon = new FitAddon();
export const webLinksAddon = new WebLinksAddon();
export const searchAddon = new SearchAddon();
export const readline = new Readline();

// ============ Initialization ============

/**
 * Initialize the terminal and mount it to the DOM.
 * Must be called after DOM is ready.
 */
export function initializeTerminal(): void {
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);  // Makes URLs clickable
    terminal.loadAddon(searchAddon);    // Enables search (Ctrl+Shift+F)
    terminal.loadAddon(readline);        // Readline for proper line editing

    terminal.open(document.getElementById('terminal')!);
    fitAddon.fit();

    // Setup Ctrl+W handler
    setupCtrlWHandler();

    // Handle window resize
    window.addEventListener('resize', () => fitAddon.fit());

    // Focus the terminal
    terminal.focus();
}

// ============ Ctrl+W Handler ============

/**
 * Add Ctrl+W (delete word) support.
 * Must intercept before browser tries to close the tab.
 */
function setupCtrlWHandler(): void {
    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Ctrl+W: Delete word backwards
        if (ev.ctrlKey && ev.key === 'w') {
            ev.preventDefault();

            // Access readline's internal state (not publicly typed but available at runtime)
            const rl = readline as unknown as { state?: { line?: { buf: string; pos: number }; editBackspace: (n: number) => void } };
            const state = rl.state;
            if (state && state.line) {
                const line = state.line;
                const buf: string = line.buf;
                const pos: number = line.pos;

                if (pos > 0) {
                    // Find word boundary: skip trailing spaces, then delete word chars
                    let deleteCount = 0;
                    let i = pos - 1;

                    // Skip any trailing whitespace
                    while (i >= 0 && /\s/.test(buf[i])) {
                        i--;
                        deleteCount++;
                    }

                    // Delete word characters (non-whitespace)
                    while (i >= 0 && !/\s/.test(buf[i])) {
                        i--;
                        deleteCount++;
                    }

                    if (deleteCount > 0) {
                        state.editBackspace(deleteCount);
                    }
                }
            }
            return false; // Prevent xterm from processing this key
        }

        return true; // Let other keys pass through
    });
}
