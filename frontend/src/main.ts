/**
 * Web Agent - Main Entry Point
 * 
 * Orchestrates the initialization of:
 * - Terminal UI (xterm.js)
 * - Sandbox Worker (WASM MCP server)
 * - Agent (Vercel AI SDK)
 * - Input handling (readline)
 */

import { terminal, readline, initializeTerminal } from './terminal';
import { showWelcome } from './terminal/welcome';
import {
    initializeSandbox,
    setSandboxCallbacks,
    callTool,
    initializeAgent,
    sendMessage,
    clearAgentHistory,
    setStatus
} from './agent';
import { handleSlashCommand, setMcpState } from './commands';
import { setupCtrlCHandler, startPromptLoop, showPrompt } from './input';

// ============ Sandbox Event Handlers ============

setSandboxCallbacks({
    onStatus: (message) => {
        setStatus(message, '#d29922');
    },

    onReady: () => {
        setStatus('Ready', '#3fb950');
        // Clear the "Initializing sandbox..." line and show Ready!
        terminal.write('\x1b[A\r\x1b[K'); // Move up one line and clear it
        terminal.write('\x1b[32m✓ Sandbox ready\x1b[0m\r\n');
    },

    onMcpInitialized: (serverInfo, tools) => {
        console.log('MCP Server initialized:', serverInfo);
        console.log('MCP Tools:', tools);

        // Update MCP state for commands module
        setMcpState(true, serverInfo, tools);

        terminal.write(`\x1b[32m✓ MCP Server ready: ${serverInfo.name} v${serverInfo.version}\x1b[0m\r\n`);
        terminal.write(`\x1b[90m  ${tools.length} tools available\x1b[0m\r\n`);

        // Initialize Agent
        initializeAgent();
        terminal.write(`\x1b[32m✓ Agent ready\x1b[0m\r\n`);

        // Setup Ctrl+C handler
        setupCtrlCHandler(readline);

        // Start the prompt loop
        startPromptLoop(readline, async (input) => {
            await sendMessage(
                terminal,
                input,
                (cmd) => handleSlashCommand(
                    terminal,
                    cmd,
                    callTool,
                    clearAgentHistory,
                    showPrompt
                ),
                showPrompt
            );
        });
    },

    onError: (message) => {
        setStatus('Error', '#ff7b72');
        terminal.write(`\x1b[31mError: ${message}\x1b[0m\r\n`);
    },

    onConsole: (message) => {
        terminal.write(`\x1b[90m[js] ${message}\x1b[0m\r\n`);
    }
});

// ============ Startup ============

// Initialize terminal and mount to DOM
initializeTerminal();

// Show welcome banner
showWelcome(terminal);

// Initialize sandbox (triggers the callback chain above)
initializeSandbox();
