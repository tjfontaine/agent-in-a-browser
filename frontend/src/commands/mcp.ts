/**
 * MCP Commands
 * 
 * Handles /mcp subcommands for remote MCP server management.
 */

import { Terminal } from '@xterm/xterm';
import { getRemoteMCPRegistry } from '../remote-mcp-registry';

// State references - will be set during initialization
let mcpInitialized = false;
let mcpServerInfo: { name: string; version: string } | null = null;
let mcpToolsList: Array<{ name: string; description?: string }> = [];

/**
 * Set MCP state from sandbox initialization.
 */
export function setMcpState(
    initialized: boolean,
    serverInfo: { name: string; version: string } | null,
    tools: Array<{ name: string; description?: string }>
): void {
    mcpInitialized = initialized;
    mcpServerInfo = serverInfo;
    mcpToolsList = tools;
}

/**
 * Get current MCP initialization state.
 */
export function isMcpInitialized(): boolean {
    return mcpInitialized;
}

/**
 * Handle /mcp subcommands for remote server management
 */
export async function handleMcpCommand(
    term: Terminal,
    subcommand: string | null,
    args: string[],
    options: Record<string, string | boolean>,
    showPrompt: () => void
): Promise<void> {
    const registry = getRemoteMCPRegistry();

    if (!subcommand) {
        // Show status (default behavior)
        showMcpStatus(term);
        showPrompt();
        return;
    }

    try {
        switch (subcommand) {
            case 'add': {
                const url = args[0];
                if (!url) {
                    term.write('\r\n\x1b[31mUsage: /mcp add <url>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                term.write(`\r\n\x1b[90mAdding server: ${url}...\x1b[0m\r\n`);

                try {
                    const server = await registry.addServer({ url });
                    term.write(`\x1b[32m✓ Added server: ${server.name} (${server.id})\x1b[0m\r\n`);

                    // Check if auth is required
                    term.write('\x1b[90mChecking authentication requirements...\x1b[0m\r\n');
                    const authRequired = await registry.checkAuthRequired(server.id);

                    if (authRequired) {
                        term.write('\x1b[33m⚠ OAuth authentication required\x1b[0m\r\n');
                        term.write(`\x1b[90mRun: /mcp auth ${server.id} <client_id>\x1b[0m\r\n`);
                    } else {
                        // Try to connect
                        term.write('\x1b[90mConnecting...\x1b[0m\r\n');
                        await registry.connectServer(server.id);
                        const updated = registry.getServer(server.id);
                        term.write(`\x1b[32m✓ Connected! ${updated?.tools.length || 0} tools available\x1b[0m\r\n`);
                    }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    term.write(`\x1b[31m✗ Failed: ${msg}\x1b[0m\r\n`);
                }
                break;
            }

            case 'remove': {
                const id = args[0];
                if (!id) {
                    term.write('\r\n\x1b[31mUsage: /mcp remove <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                try {
                    await registry.removeServer(id);
                    term.write(`\r\n\x1b[32m✓ Removed server: ${id}\x1b[0m\r\n`);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    term.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
                }
                break;
            }

            case 'auth': {
                const id = args[0];
                // Support both --client-id option and positional arg for backwards compat
                const clientId = (options['client-id'] as string) || args[1];
                if (!id) {
                    term.write('\r\n\x1b[31mUsage: /mcp auth <id> [--client-id <id>]\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                const server = registry.getServer(id);
                if (!server) {
                    term.write(`\r\n\x1b[31m✗ Server not found: ${id}\x1b[0m\r\n`);
                    showPrompt();
                    return;
                }

                const effectiveClientId = clientId || server.oauthClientId;
                if (!effectiveClientId) {
                    term.write('\r\n\x1b[31m✗ OAuth client ID required\x1b[0m\r\n');
                    term.write('\x1b[90mUsage: /mcp auth <id> --client-id <your-client-id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                term.write(`\r\n\x1b[90mOpening OAuth popup for ${server.name}...\x1b[0m\r\n`);
                term.write('\x1b[33m⚠ Please complete authentication in the popup window\x1b[0m\r\n');

                try {
                    await registry.authenticateServer(id, effectiveClientId);
                    term.write('\x1b[32m✓ Authentication successful!\x1b[0m\r\n');

                    // Auto-connect after auth
                    term.write('\x1b[90mConnecting...\x1b[0m\r\n');
                    await registry.connectServer(id);
                    const updated = registry.getServer(id);
                    term.write(`\x1b[32m✓ Connected! ${updated?.tools.length || 0} tools available\x1b[0m\r\n`);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    term.write(`\x1b[31m✗ Authentication failed: ${msg}\x1b[0m\r\n`);
                }
                break;
            }

            case 'connect': {
                const id = args[0];
                if (!id) {
                    term.write('\r\n\x1b[31mUsage: /mcp connect <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                term.write(`\r\n\x1b[90mConnecting to ${id}...\x1b[0m\r\n`);

                try {
                    await registry.connectServer(id);
                    const server = registry.getServer(id);
                    term.write(`\x1b[32m✓ Connected! ${server?.tools.length || 0} tools available\x1b[0m\r\n`);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    term.write(`\x1b[31m✗ Connection failed: ${msg}\x1b[0m\r\n`);
                }
                break;
            }

            case 'disconnect': {
                const id = args[0];
                if (!id) {
                    term.write('\r\n\x1b[31mUsage: /mcp disconnect <id>\x1b[0m\r\n');
                    showPrompt();
                    return;
                }

                try {
                    await registry.disconnectServer(id);
                    term.write(`\r\n\x1b[32m✓ Disconnected: ${id}\x1b[0m\r\n`);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    term.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
                }
                break;
            }

            case 'list':
                showMcpStatus(term);
                break;

            default:
                term.write(`\r\n\x1b[31mUnknown /mcp subcommand: ${subcommand}\x1b[0m\r\n`);
                term.write('\x1b[90mAvailable: add, remove, auth, connect, disconnect, list\x1b[0m\r\n');
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        term.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`);
    }

    showPrompt();
}

/**
 * Display MCP status including local and remote servers
 */
export function showMcpStatus(term: Terminal): void {
    const registry = getRemoteMCPRegistry();
    const remoteServers = registry.getServers();

    term.write('\r\n\x1b[36m┌─ MCP Status ─────────────────────────\x1b[0m\r\n');
    term.write(`\x1b[36m│\x1b[0m Initialized: ${mcpInitialized ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}\r\n`);

    // Local WASM MCP Server
    if (mcpServerInfo) {
        term.write(`\x1b[36m│\x1b[0m\r\n`);
        term.write(`\x1b[36m│\x1b[0m \x1b[1m📦 Local: ${mcpServerInfo.name}\x1b[0m v${mcpServerInfo.version}\r\n`);
        term.write(`\x1b[36m│\x1b[0m Tools (${mcpToolsList.length}):\r\n`);
        for (const tool of mcpToolsList) {
            const desc = tool.description ? ` - ${tool.description.substring(0, 40)}${tool.description.length > 40 ? '...' : ''}` : '';
            term.write(`\x1b[36m│\x1b[0m   \x1b[33m${tool.name}\x1b[0m\x1b[90m${desc}\x1b[0m\r\n`);
        }
    }

    // Remote MCP Servers
    if (remoteServers.length > 0) {
        term.write(`\x1b[36m│\x1b[0m\r\n`);
        term.write(`\x1b[36m│\x1b[0m \x1b[1m🌐 Remote Servers (${remoteServers.length}):\x1b[0m\r\n`);

        for (const server of remoteServers) {
            const statusIcon = getStatusIcon(server.status);
            const statusColor = getStatusColor(server.status);

            term.write(`\x1b[36m│\x1b[0m\r\n`);
            term.write(`\x1b[36m│\x1b[0m   ${statusIcon} \x1b[1m${server.name}\x1b[0m \x1b[90m(${server.id})\x1b[0m\r\n`);
            term.write(`\x1b[36m│\x1b[0m     URL: \x1b[90m${server.url}\x1b[0m\r\n`);
            term.write(`\x1b[36m│\x1b[0m     Auth: \x1b[90m${server.authType}\x1b[0m  Status: ${statusColor}${server.status}\x1b[0m\r\n`);

            if (server.error) {
                term.write(`\x1b[36m│\x1b[0m     \x1b[31mError: ${server.error}\x1b[0m\r\n`);
            }

            if (server.status === 'connected' && server.tools.length > 0) {
                term.write(`\x1b[36m│\x1b[0m     Tools (${server.tools.length}):\r\n`);
                for (const tool of server.tools.slice(0, 5)) {
                    const desc = tool.description ? ` - ${tool.description.substring(0, 30)}...` : '';
                    term.write(`\x1b[36m│\x1b[0m       \x1b[33m${tool.name}\x1b[0m\x1b[90m${desc}\x1b[0m\r\n`);
                }
                if (server.tools.length > 5) {
                    term.write(`\x1b[36m│\x1b[0m       \x1b[90m...and ${server.tools.length - 5} more\x1b[0m\r\n`);
                }
            }
        }
    } else {
        term.write(`\x1b[36m│\x1b[0m\r\n`);
        term.write(`\x1b[36m│\x1b[0m \x1b[90mNo remote servers. Use /mcp add <url> to add one.\x1b[0m\r\n`);
    }

    term.write('\x1b[36m└──────────────────────────────────────\x1b[0m\r\n');
}

function getStatusIcon(status: string): string {
    switch (status) {
        case 'connected': return '\x1b[32m●\x1b[0m';
        case 'connecting': return '\x1b[33m◐\x1b[0m';
        case 'auth_required': return '\x1b[33m🔒\x1b[0m';
        case 'error': return '\x1b[31m✗\x1b[0m';
        default: return '\x1b[90m○\x1b[0m';
    }
}

function getStatusColor(status: string): string {
    switch (status) {
        case 'connected': return '\x1b[32m';
        case 'connecting': return '\x1b[33m';
        case 'auth_required': return '\x1b[33m';
        case 'error': return '\x1b[31m';
        default: return '\x1b[90m';
    }
}
