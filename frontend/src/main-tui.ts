/**
 * Main entry point for Web Agent TUI
 * 
 * This uses the Rust/ratatui-based TUI instead of the React app.
 * The React code is kept for reference but not used.
 */

// NOTE: tui-loader is NOT statically imported because it contains static imports
// of JSPI-transpiled WASM modules that fail in Safari (WebAssembly.Suspending is undefined)
// Instead, we dynamically import it only when JSPI is available.

import './index.css';

// Import OAuth handler to register window.__mcpOAuthHandler
import './oauth-handler.js';

import { hasJSPI } from '@tjfontaine/mcp-wasm-server';
import { WorkerBridge } from '@tjfontaine/wasi-shims';

// Create full-screen terminal container
const root = document.getElementById('root')!;
root.innerHTML = '<div id="terminal" style="width: 100%; height: 100vh;"></div>';

const terminalEl = document.getElementById('terminal')!;

// Auto-launch the TUI
(async () => {
    try {
        console.log('[Main] Launching TUI...');
        console.log(`[Main] JSPI support: ${hasJSPI ? 'YES' : 'NO'}`);

        let terminalInstance;

        if (!hasJSPI) {
            console.log('[Main] Non-JSPI browser detected (Safari?), launching WorkerBridge...');

            // Initialize the sandbox worker first (for MCP)
            // This runs ts-runtime-mcp to handle MCP requests
            // Use fetchFromSandboxSimple for Safari - MessageChannel ports fail silently in Safari workers
            const { initializeSandbox, fetchFromSandboxSimple } = await import('./agent/sandbox.js');
            console.log('[Main] Initializing sandbox for MCP...');
            await initializeSandbox();
            console.log('[Main] Sandbox ready');

            // Initialize ghostty-web and create terminal
            const ghostty = await import('ghostty-web');
            await ghostty.init();

            const terminal = new ghostty.Terminal({
                fontSize: 14,
                theme: {
                    background: '#1a1b26',
                    foreground: '#a9b1d6',
                    cursor: '#c0caf5',
                }
            });
            terminal.open(terminalEl);
            terminalInstance = terminal;

            // Load FitAddon for proper sizing (same as JSPI mode)
            const fitAddon = new ghostty.FitAddon();
            terminal.loadAddon(fitAddon);
            fitAddon.fit();

            // Create MCP transport handler that routes through sandbox
            const mcpTransport = async (
                method: string,
                url: string,
                headers: Record<string, string>,
                body: Uint8Array | null
            ) => {
                console.log('[Main] mcpTransport called:', method, url);
                // Extract path from URL
                const urlObj = new URL(url);
                const path = urlObj.pathname;

                console.log('[Main] Calling fetchFromSandboxSimple:', path);
                const fetchOptions: RequestInit = { method, headers };
                if (body) fetchOptions.body = new Blob([body as BlobPart]);

                const response = await fetchFromSandboxSimple(path, fetchOptions);
                console.log('[Main] fetchFromSandboxSimple returned:', response.status);
                const responseBody = new Uint8Array(await response.arrayBuffer());

                return { status: response.status, body: responseBody };
            };

            // Launch worker bridge with MCP transport
            const bridge = new WorkerBridge(terminal, { mcpTransport });
            await bridge.start();

            // Wire terminal resize events to WorkerBridge
            terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
                console.log('[Main] Terminal resized (ghostty):', cols, 'x', rows);
                bridge.handleResize(cols, rows);
            });

            // Use FitAddon's observeResize for automatic resize handling
            fitAddon.observeResize();
            console.log('[Main] FitAddon initialized:', terminal.cols, 'x', terminal.rows);

            // Send initial size to worker
            bridge.handleResize(terminal.cols, terminal.rows);

            // Run the TUI module
            bridge.runModule('tui');

        } else {
            console.log('[Main] JSPI supported, launching direct WASM...');

            // Dynamic import of tui-loader to prevent Safari from parsing JSPI modules
            const { launchTui } = await import('./wasm/tui/tui-loader.js');

            const { terminal } = await launchTui({
                container: terminalEl,
                fontSize: 14,
                theme: {
                    background: '#1a1b26',
                    foreground: '#a9b1d6',
                    cursor: '#c0caf5',
                }
            });
            terminalInstance = terminal;
        }

        // Focus the terminal
        // Focus the terminal
        if (terminalInstance) {
            terminalInstance.focus();
        }

        // Expose terminal for E2E tests
        // Expose terminal for E2E tests
        if (terminalInstance) {
            (window as unknown as { tuiTerminal: unknown }).tuiTerminal = terminalInstance;
        }

        console.log('[Main] TUI running');

    } catch (err) {
        console.error('[Main] TUI launch error:', err);
        terminalEl.innerHTML = `<pre style="color: #f7768e; padding: 1rem;">Error launching TUI:\n${err}</pre>`;
    }
})();
