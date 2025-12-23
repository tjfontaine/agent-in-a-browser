/**
 * /mcp Command
 * 
 * MCP server management with subcommands.
 */

import { CommandDef, colors } from './types';
import { getMcpStatusData } from './mcp';
import { getRemoteMCPRegistry } from '../remote-mcp-registry';

export const mcpCommand: CommandDef = {
    name: 'mcp',
    description: 'Manage MCP servers',

    // Tab completion for subcommands
    completions: (partial, args) => {
        if (args.length === 0 || (args.length === 1 && partial)) {
            const subcommands = ['list', 'add', 'remove', 'auth', 'connect', 'disconnect'];
            const search = args[0] || '';
            return subcommands
                .filter(sub => sub.startsWith(search))
                .map(sub => `/mcp ${sub}`);
        }
        return [];
    },

    subcommands: [
        {
            name: 'list',
            description: 'List remote servers with details',
            usage: '/mcp list',
            handler: (ctx) => {
                const registry = getRemoteMCPRegistry();
                const servers = registry.getServers();

                if (servers.length === 0) {
                    ctx.output('system', 'No remote servers configured.', colors.dim);
                    ctx.output('system', 'Use /mcp add <url> to add one.', colors.dim);
                    return;
                }

                ctx.output('system', '', undefined);
                ctx.output('system', '🌐 Remote MCP Servers:', colors.magenta);
                ctx.output('system', '', undefined);

                for (const server of servers) {
                    const statusIcon = server.status === 'connected' ? '●' : '○';
                    const statusColor = server.status === 'connected' ? colors.green : colors.dim;

                    ctx.output('system', `${statusIcon} ${server.name}`, statusColor);
                    ctx.output('system', `  ID:     ${server.id}`, colors.cyan);
                    ctx.output('system', `  URL:    ${server.url}`, colors.dim);
                    ctx.output('system', `  Status: ${server.status}`, statusColor);
                    ctx.output('system', `  Tools:  ${server.tools.length}`, colors.dim);
                    ctx.output('system', '', undefined);
                }

                ctx.output('system', 'Commands:', colors.dim);
                ctx.output('system', '  /mcp connect <ID>    - Connect to server', colors.dim);
                ctx.output('system', '  /mcp disconnect <ID> - Disconnect from server', colors.dim);
                ctx.output('system', '  /mcp remove <ID>     - Remove server', colors.dim);
            },
        },
        {
            name: 'add',
            description: 'Add a remote MCP server',
            usage: '/mcp add <url>',
            handler: async (ctx, args) => {
                const registry = getRemoteMCPRegistry();
                const url = args[0];
                if (!url) {
                    ctx.output('error', 'Usage: /mcp add <url>', colors.red);
                    return;
                }
                ctx.output('system', `Adding server: ${url}...`, colors.dim);
                const server = await registry.addServer({ url });
                ctx.output('system', `✓ Added server: ${server.name} (${server.id})`, colors.green);
            },
        },
        {
            name: 'remove',
            description: 'Remove a remote MCP server',
            usage: '/mcp remove <id>',
            handler: async (ctx, args) => {
                const registry = getRemoteMCPRegistry();
                const id = args[0];
                if (!id) {
                    ctx.output('error', 'Usage: /mcp remove <id>', colors.red);
                    return;
                }
                await registry.removeServer(id);
                ctx.output('system', `✓ Removed server: ${id}`, colors.green);
            },
        },
        {
            name: 'auth',
            description: 'Authenticate with OAuth (auto-registers if server supports DCR)',
            usage: '/mcp auth <id> [--client-id <id>]',
            handler: async (ctx, args) => {
                const registry = getRemoteMCPRegistry();
                const id = args[0];
                const clientId = args[1];
                if (!id) {
                    ctx.output('error', 'Usage: /mcp auth <id> [--client-id <id>]', colors.red);
                    ctx.output('system', 'Client ID is optional - will use Dynamic Client Registration if supported', colors.dim);
                    return;
                }
                ctx.output('system', 'Opening OAuth popup...', colors.dim);
                if (!clientId) {
                    ctx.output('system', 'No client ID provided - will attempt Dynamic Client Registration', colors.dim);
                }
                await registry.authenticateServer(id, clientId);
                ctx.output('system', '✓ Authentication successful!', colors.green);
            },
        },
        {
            name: 'connect',
            description: 'Connect to a remote server',
            usage: '/mcp connect <id>',
            handler: async (ctx, args) => {
                const registry = getRemoteMCPRegistry();
                const id = args[0];
                if (!id) {
                    ctx.output('error', 'Usage: /mcp connect <id>', colors.red);
                    return;
                }
                ctx.output('system', `Connecting to ${id}...`, colors.dim);
                await registry.connectServer(id);
                const server = registry.getServer(id);
                ctx.output('system', `✓ Connected! ${server?.tools.length || 0} tools available`, colors.green);
            },
        },
        {
            name: 'disconnect',
            description: 'Disconnect from a server',
            usage: '/mcp disconnect <id>',
            handler: async (ctx, args) => {
                const registry = getRemoteMCPRegistry();
                const id = args[0];
                if (!id) {
                    ctx.output('error', 'Usage: /mcp disconnect <id>', colors.red);
                    return;
                }
                await registry.disconnectServer(id);
                ctx.output('system', `✓ Disconnected: ${id}`, colors.green);
            },
        },
    ],

    // Default handler (no subcommand) - show status
    handler: (ctx) => {
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
                const statusIcon = server.status === 'connected' ? '●' : '○';
                const statusColor = server.status === 'connected' ? colors.green : colors.dim;
                ctx.output('system', `│   ${statusIcon} ${server.name}`, statusColor);
                ctx.output('system', `│     ID: ${server.id} | ${server.status} | ${server.toolCount} tools`, colors.dim);
            }
            ctx.output('system', '│', colors.cyan);
            ctx.output('system', '│ Use: /mcp connect <ID> | /mcp disconnect <ID>', colors.dim);
        } else {
            ctx.output('system', '│', colors.cyan);
            ctx.output('system', '│ No remote servers. Use /mcp add <url>', colors.dim);
        }
        ctx.output('system', '└──────────────────────────────────────', colors.cyan);
    },
};
