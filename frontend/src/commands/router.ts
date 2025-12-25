/**
 * Command Router
 * 
 * Routes slash commands to their appropriate handlers.
 */

import { Terminal } from '@xterm/xterm';
import { parseSlashCommand } from './Parser';
import { handleMcpCommand } from './mcp';

/**
 * Handle a slash command input.
 * 
 * @param term - Terminal instance for output
 * @param input - Raw input string starting with /
 * @param clearHistory - Function to clear agent conversation history
 * @param showPrompt - Function to show the prompt again
 */
export function handleSlashCommand(
    term: Terminal,
    input: string,
    clearHistory: () => void,
    showPrompt: () => void
): void {
    const parsed = parseSlashCommand(input);

    if (!parsed) {
        term.write(`\r\n\x1b[31mInvalid command format\x1b[0m\r\n`);
        showPrompt();
        return;
    }

    const { command, subcommand, args, options } = parsed;

    switch (command) {
        case 'clear':
            term.clear();
            clearHistory();
            term.write('\x1b[90mConversation cleared.\x1b[0m\r\n');
            showPrompt();
            break;

        case 'mcp':
            // Pass subcommand and args to MCP handler
            handleMcpCommand(term, subcommand, args, options, showPrompt);
            break;

        case 'help':
            term.write('\r\n\x1b[36mCommands:\x1b[0m\r\n');
            term.write('  /clear              - Clear conversation\r\n');
            term.write('  /mcp                - Show MCP status\r\n');
            term.write('  /mcp add <url>      - Add remote MCP server\r\n');
            term.write('  /mcp remove <id>    - Remove remote server\r\n');
            term.write('  /mcp auth <id> [--client-id <id>] - Authenticate with OAuth\r\n');
            term.write('  /mcp connect <id>   - Connect to remote server\r\n');
            term.write('  /mcp disconnect <id> - Disconnect from server\r\n');
            term.write('  /help               - Show this help\r\n');
            showPrompt();
            break;

        default:
            term.write(`\r\n\x1b[31mUnknown command: /${command}\x1b[0m\r\n`);
            term.write('\x1b[90mType /help for available commands\x1b[0m\r\n');
            showPrompt();
    }
}

