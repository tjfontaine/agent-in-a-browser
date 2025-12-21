/**
 * React Command Handler
 * 
 * Handles slash commands with an Output interface for React components.
 * This replaces the xterm-based command router for the ink-web TUI.
 */

import { parseSlashCommand } from '../command-parser';
import { getMcpStatusData } from './mcp';
import { getRemoteMCPRegistry } from '../remote-mcp-registry';

// Colors for output
const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    magenta: '#bc8cff',
    dim: '#8b949e',
};

// Output function type - matches useAgent's addOutput
export type OutputFn = (
    type: 'text' | 'tool-start' | 'tool-result' | 'error' | 'system',
    content: string,
    color?: string
) => void;

// Command context provided to handlers
export interface CommandContext {
    output: OutputFn;
    clearHistory: () => void;
    sendMessage: (msg: string) => void;
}

// Command handler function type
type CommandHandler = (
    ctx: CommandContext,
    args: string[],
    options: Record<string, string | boolean>
) => Promise<void> | void;

// Command registry
const commands: Record<string, CommandHandler> = {};

// Register a command
export function registerCommand(name: string, handler: CommandHandler): void {
    commands[name] = handler;
}

// Get all registered command names (for tab completion)
export function getRegisteredCommands(): string[] {
    return Object.keys(commands);
}

// Get completions for a partial input
export function getCommandCompletions(input: string): string[] {
    if (!input.startsWith('/')) return [];

    const partial = input.slice(1).toLowerCase();
    const parts = partial.split(/\s+/);

    // Completing command name
    if (parts.length === 1) {
        const matching = Object.keys(commands)
            .filter(cmd => cmd.startsWith(parts[0]))
            .map(cmd => `/${cmd}`);
        return matching;
    }

    // Completing /mcp subcommands
    if (parts[0] === 'mcp' && parts.length === 2) {
        const subcommands = ['add', 'remove', 'auth', 'connect', 'disconnect'];
        const matching = subcommands
            .filter(sub => sub.startsWith(parts[1]))
            .map(sub => `/mcp ${sub}`);
        return matching;
    }

    return [];
}

// Execute a slash command
export async function executeCommand(
    input: string,
    ctx: CommandContext
): Promise<boolean> {
    const parsed = parseSlashCommand(input);

    if (!parsed) {
        ctx.output('error', 'Invalid command format', colors.red);
        return true;
    }

    const { command, subcommand, args, options } = parsed;

    // Combine subcommand with args if present
    const fullArgs = subcommand ? [subcommand, ...args] : args;

    const handler = commands[command];
    if (!handler) {
        ctx.output('error', `Unknown command: /${command}`, colors.red);
        ctx.output('system', 'Type /help for available commands', colors.dim);
        return true;
    }

    try {
        await handler(ctx, fullArgs, options);
    } catch (e) {
        ctx.output('error', `Command error: ${e instanceof Error ? e.message : String(e)}`, colors.red);
    }

    return true;
}

// ============ Built-in Commands ============

// /help
registerCommand('help', (ctx) => {
    ctx.output('system', '', undefined);
    ctx.output('system', 'Commands:', colors.cyan);
    ctx.output('system', '  /help              - Show this help');
    ctx.output('system', '  /clear             - Clear conversation');
    ctx.output('system', '  /files [path]      - List files in sandbox');
    ctx.output('system', '', undefined);
    ctx.output('system', 'MCP Commands:', colors.cyan);
    ctx.output('system', '  /mcp               - Show MCP server status');
    ctx.output('system', '  /mcp add <url>     - Add remote MCP server');
    ctx.output('system', '  /mcp remove <id>   - Remove remote server');
    ctx.output('system', '  /mcp auth <id>     - Authenticate with OAuth');
    ctx.output('system', '  /mcp connect <id>  - Connect to remote server');
    ctx.output('system', '  /mcp disconnect <id> - Disconnect from server');
    ctx.output('system', '');
});

// /clear
registerCommand('clear', (ctx) => {
    ctx.clearHistory();
});

// /files
registerCommand('files', (ctx, args) => {
    const path = args[0] || '/';
    ctx.sendMessage(`List the files in ${path}`);
});

// /mcp - with subcommands
registerCommand('mcp', async (ctx, args) => {
    const [subcommand, ...subArgs] = args;
    const registry = getRemoteMCPRegistry();

    if (!subcommand) {
        // Show status
        const mcpData = getMcpStatusData();
        ctx.output('system', '', undefined);
        ctx.output('system', '┌─ MCP Status ─────────────────────────', colors.cyan);
        ctx.output('system', `│ Initialized: ${mcpData.initialized ? '✓' : '✗'}`, mcpData.initialized ? colors.green : colors.red);

        if (mcpData.serverInfo) {
            ctx.output('system', '│', colors.cyan);
            ctx.output('system', `│ 📦 Local: ${mcpData.serverInfo.name} v${mcpData.serverInfo.version}`, colors.green);
            ctx.output('system', `│   Tools (${mcpData.tools.length}):`, colors.dim);
            for (const tool of mcpData.tools.slice(0, 6)) {
                ctx.output('system', `│     • ${tool.name}`, colors.yellow);
            }
            if (mcpData.tools.length > 6) {
                ctx.output('system', `│     ...and ${mcpData.tools.length - 6} more`, colors.dim);
            }
        }

        if (mcpData.remoteServers.length > 0) {
            ctx.output('system', '│', colors.cyan);
            ctx.output('system', `│ 🌐 Remote Servers (${mcpData.remoteServers.length}):`, colors.magenta);
            for (const server of mcpData.remoteServers) {
                const statusColor = server.status === 'connected' ? colors.green : colors.dim;
                ctx.output('system', `│   ${server.name} (${server.status}) - ${server.toolCount} tools`, statusColor);
            }
        } else {
            ctx.output('system', '│', colors.cyan);
            ctx.output('system', '│ No remote servers. Use /mcp add <url>', colors.dim);
        }
        ctx.output('system', '└──────────────────────────────────────', colors.cyan);
        return;
    }

    switch (subcommand) {
        case 'add': {
            const url = subArgs[0];
            if (!url) {
                ctx.output('error', 'Usage: /mcp add <url>', colors.red);
                return;
            }
            ctx.output('system', `Adding server: ${url}...`, colors.dim);
            const server = await registry.addServer({ url });
            ctx.output('system', `✓ Added server: ${server.name} (${server.id})`, colors.green);
            break;
        }

        case 'remove': {
            const id = subArgs[0];
            if (!id) {
                ctx.output('error', 'Usage: /mcp remove <id>', colors.red);
                return;
            }
            await registry.removeServer(id);
            ctx.output('system', `✓ Removed server: ${id}`, colors.green);
            break;
        }

        case 'auth': {
            const id = subArgs[0];
            const clientId = subArgs[1];
            if (!id) {
                ctx.output('error', 'Usage: /mcp auth <id> [client-id]', colors.red);
                return;
            }
            ctx.output('system', 'Opening OAuth popup...', colors.dim);
            await registry.authenticateServer(id, clientId);
            ctx.output('system', '✓ Authentication successful!', colors.green);
            break;
        }

        case 'connect': {
            const id = subArgs[0];
            if (!id) {
                ctx.output('error', 'Usage: /mcp connect <id>', colors.red);
                return;
            }
            ctx.output('system', `Connecting to ${id}...`, colors.dim);
            await registry.connectServer(id);
            const server = registry.getServer(id);
            ctx.output('system', `✓ Connected! ${server?.tools.length || 0} tools available`, colors.green);
            break;
        }

        case 'disconnect': {
            const id = subArgs[0];
            if (!id) {
                ctx.output('error', 'Usage: /mcp disconnect <id>', colors.red);
                return;
            }
            await registry.disconnectServer(id);
            ctx.output('system', `✓ Disconnected: ${id}`, colors.green);
            break;
        }

        default:
            ctx.output('error', `Unknown /mcp subcommand: ${subcommand}`, colors.red);
            ctx.output('system', 'Available: add, remove, auth, connect, disconnect', colors.dim);
    }
});
