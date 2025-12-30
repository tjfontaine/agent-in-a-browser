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
import { setTerminal, setTerminalSize } from './ghostty-cli-shim.js';

// Import transport handler for routing MCP requests  
import { setTransportHandler } from './wasi-http-impl.js';

// Import sandbox for MCP routing
import { fetchFromSandbox, initializeSandbox } from '../agent/sandbox.js';

// Import OPFS filesystem init for shell access
import { initFilesystem } from './opfs-filesystem-impl.js';

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
 * Create a transport handler that routes MCP requests through the sandbox worker
 */
function createSandboxTransport() {
    return async (
        method: string,
        url: string,
        headers: Record<string, string>,
        body: Uint8Array | null
    ): Promise<{ status: number; headers: [string, Uint8Array][]; body: Uint8Array }> => {
        // Extract path from URL (e.g., /mcp/message from http://localhost:3000/mcp/message)
        const urlObj = new URL(url);
        const path = urlObj.pathname;

        console.log('[Transport] Routing to sandbox:', method, path);

        // Build fetch options
        const fetchOptions: RequestInit = {
            method,
            headers: headers,
        };

        if (body) {
            fetchOptions.body = new Blob([body as BlobPart]);
        }

        // Route through sandbox worker
        const response = await fetchFromSandbox(path, fetchOptions);

        // Convert response
        const responseBody = new Uint8Array(await response.arrayBuffer());
        const responseHeaders: [string, Uint8Array][] = [];
        response.headers.forEach((value, name) => {
            responseHeaders.push([name.toLowerCase(), new TextEncoder().encode(value)]);
        });

        return {
            status: response.status,
            headers: responseHeaders,
            body: responseBody
        };
    };
}

/**
 * Launch the TUI in a container element
 */
export async function launchTui(options: TuiLoaderOptions): Promise<{
    terminal: Terminal;
    stop: () => void;
}> {
    // Initialize the sandbox worker first (for MCP)
    console.log('[TUI Loader] Initializing sandbox...');
    await initializeSandbox();
    console.log('[TUI Loader] Sandbox ready');

    // Set up transport handler to route MCP requests through sandbox
    setTransportHandler(createSandboxTransport());
    console.log('[TUI Loader] Transport handler configured');

    // Initialize OPFS filesystem for shell access (touch, mkdir, ls, etc.)
    console.log('[TUI Loader] Initializing OPFS filesystem...');
    await initFilesystem();
    console.log('[TUI Loader] OPFS filesystem ready');

    // Initialize ghostty-web
    await initGhostty();

    // Create terminal with sensible defaults
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

    // Set initial size
    setTerminalSize(terminal.cols, terminal.rows);

    // Listen for resize events
    terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        console.log('[TUI Loader] Terminal resized:', cols, 'x', rows);
        setTerminalSize(cols, rows);
    });

    let _running = true;
    const stop = () => {
        _running = false;
        setTransportHandler(null); // Clean up transport handler
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
