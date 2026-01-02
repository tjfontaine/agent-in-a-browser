/**
 * Main entry point for Web Agent TUI
 * 
 * This uses the Rust/ratatui-based TUI instead of the React app.
 * The React code is kept for reference but not used.
 */

import { launchTui } from './wasm/tui/tui-loader.js';
import './index.css';

// Import OAuth handler to register window.__mcpOAuthHandler
import './oauth-handler.js';

// Create full-screen terminal container
const root = document.getElementById('root')!;
root.innerHTML = '<div id="terminal" style="width: 100%; height: 100vh;"></div>';

const terminalEl = document.getElementById('terminal')!;

// Auto-launch the TUI
(async () => {
    try {
        console.log('[Main] Launching TUI...');

        const { terminal } = await launchTui({
            container: terminalEl,
            fontSize: 14,
            theme: {
                background: '#1a1b26',
                foreground: '#a9b1d6',
                cursor: '#c0caf5',
            }
        });

        // Focus the terminal
        terminal.focus();

        // Expose terminal for E2E tests
        (window as unknown as { tuiTerminal: typeof terminal }).tuiTerminal = terminal;

        console.log('[Main] TUI running');

    } catch (err) {
        console.error('[Main] TUI launch error:', err);
        terminalEl.innerHTML = `<pre style="color: #f7768e; padding: 1rem;">Error launching TUI:\n${err}</pre>`;
    }
})();
