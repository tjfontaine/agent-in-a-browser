/**
 * TUI Loader - Connects ghostty-web terminal to web-agent-tui WASM
 * 
 * This module provides the bridge between ghostty-web's terminal emulator
 * and the ratatui-based TUI running as a WASM component.
 */

// Import ghostty-web terminal
import { init as initGhostty, Terminal } from 'ghostty-web';

// Import the TUI WASM module (transpiled with jco)
import { run } from './web-agent-tui/web-agent-tui.js';

// Import the CLI shim to set up the terminal
import { setTerminal } from './ghostty-cli-shim.js';

export interface TuiLoaderOptions {
    container: HTMLElement;
    fontSize?: number;
    theme?: {
        background?: string;
        foreground?: string;
        cursor?: string;
    };
}

/**
 * Launch the TUI in a container element
 */
export async function launchTui(options: TuiLoaderOptions): Promise<{
    terminal: Terminal;
    stop: () => void;
}> {
    // Initialize ghostty-web
    await initGhostty();

    // Create terminal
    const terminal = new Terminal({
        fontSize: options.fontSize ?? 14,
        theme: {
            background: options.theme?.background ?? '#1a1b26',
            foreground: options.theme?.foreground ?? '#a9b1d6',
            cursor: options.theme?.cursor ?? '#c0caf5',
        },
    });

    // Mount terminal
    terminal.open(options.container);

    // Wire terminal to our CLI shims
    setTerminal(terminal);

    let _running = true;
    const stop = () => {
        _running = false;
    };

    // Run the TUI (async)
    run().then(exitCode => {
        console.log('TUI exited with code:', exitCode);
    }).catch(err => {
        console.error('TUI error:', err);
    });

    return { terminal, stop };
}

/**
 * Export for simple usage
 */
export { Terminal };
