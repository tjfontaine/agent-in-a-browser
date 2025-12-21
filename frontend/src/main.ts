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
    initializeAgent,
    sendMessage,
    clearAgentHistory,
    setStatus
} from './agent';
import { handleSlashCommand, setMcpState } from './commands';
import { setupCtrlCHandler, startPromptLoop, showPrompt } from './input';
import { initializeWasmMcp } from './agent-sdk';

// ============ Startup ============

async function main() {
    // Initialize terminal and mount to DOM
    initializeTerminal();

    // Show welcome banner
    showWelcome(terminal);

    terminal.write('Initializing sandbox...\r\n');
    setStatus('Initializing...', '#d29922');

    try {
        // Initialize sandbox worker
        await initializeSandbox();
        terminal.write('\x1b[32m✓ Sandbox ready\x1b[0m\r\n');

        // Initialize MCP over workerFetch
        const tools = await initializeWasmMcp();
        const serverInfo = { name: 'wasm-mcp-server', version: '0.1.0' };

        // Update MCP state for commands module
        setMcpState(true, serverInfo, tools);

        terminal.write(`\x1b[32m✓ MCP Server ready: ${serverInfo.name} v${serverInfo.version}\x1b[0m\r\n`);
        terminal.write(`\x1b[90m  ${tools.length} tools available\x1b[0m\r\n`);

        // Initialize Agent
        initializeAgent();
        terminal.write('\x1b[32m✓ Agent ready\x1b[0m\r\n');

        setStatus('Ready', '#3fb950');

        // Setup Ctrl+C handler
        setupCtrlCHandler(readline);

        // Start the prompt loop
        startPromptLoop(readline, async (input: string) => {
            await sendMessage(
                terminal,
                input,
                (cmd: string) => handleSlashCommand(
                    terminal,
                    cmd,
                    clearAgentHistory,
                    showPrompt
                ),
                showPrompt
            );
        });
    } catch (error: any) {
        setStatus('Error', '#ff7b72');
        terminal.write(`\x1b[31mError: ${error.message}\x1b[0m\r\n`);
        console.error('Startup error:', error);
    }
}

main();


