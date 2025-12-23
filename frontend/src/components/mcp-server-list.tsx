/**
 * MCP Server List Component
 * 
 * Interactive list for managing MCP servers using @inkjs/ui Select.
 * Supports connect/disconnect/remove/token actions + adding new servers.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, TextInput } from '@inkjs/ui';
import { getRemoteMCPRegistry, RemoteMCPServer } from '../remote-mcp-registry';
import { getMcpStatusData } from '../commands/mcp';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    dim: '#8b949e',
    magenta: '#bc8cff',
};

interface McpServerListProps {
    onExit: () => void;
    onAction?: (action: string, serverId: string) => Promise<void>;
}

type ViewMode = 'list' | 'actions' | 'add-server' | 'set-token';

export function McpServerList({ onExit, onAction }: McpServerListProps) {
    const [servers, setServers] = useState<RemoteMCPServer[]>([]);
    const [selectedServer, setSelectedServer] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('list');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    // Ref to guard against re-entry during async operations
    const processingRef = useRef(false);

    const registry = getRemoteMCPRegistry();

    // Load servers - registry is a stable singleton so we only need to subscribe once
    useEffect(() => {
        const registry = getRemoteMCPRegistry();
        setServers(registry.getServers());
        const unsub = registry.subscribe(() => {
            setServers(registry.getServers());
        });
        return unsub;
    }, []);

    // Handle escape to exit/go back
    useInput((_input, key) => {
        if (key.escape) {
            if (viewMode === 'actions' || viewMode === 'add-server' || viewMode === 'set-token') {
                setViewMode('list');
                setSelectedServer(null);
            } else {
                onExit();
            }
        }
    });

    const handleServerSelect = (value: string) => {
        if (value === '__add__') {
            setViewMode('add-server');
        } else if (value === '__local__') {
            setSelectedServer('__local__');
            setViewMode('actions');
        } else {
            setSelectedServer(value);
            setViewMode('actions');
        }
    };

    const handleAction = async (action: string) => {
        if (!selectedServer) return;

        // Guard against re-entry while an action is in progress
        if (processingRef.current) return;

        if (action === 'back') {
            setViewMode('list');
            setSelectedServer(null);
            return;
        }

        if (action === 'token') {
            setViewMode('set-token');
            return;
        }

        processingRef.current = true;
        setLoading(true);
        setMessage(`${action}...`);

        try {
            if (onAction) {
                await onAction(action, selectedServer);
            } else {
                // Default handling
                if (action === 'connect') {
                    await registry.connectServer(selectedServer);
                    setMessage('✓ Connected!');
                    // Return to list to avoid Select re-trigger with changed options
                    setViewMode('list');
                    setSelectedServer(null);
                } else if (action === 'disconnect') {
                    await registry.disconnectServer(selectedServer);
                    setMessage('✓ Disconnected');
                    // Return to list
                    setViewMode('list');
                    setSelectedServer(null);
                } else if (action === 'remove') {
                    await registry.removeServer(selectedServer);
                    setMessage('✓ Removed');
                    setSelectedServer(null);
                    setViewMode('list');
                } else if (action === 'auth') {
                    await registry.authenticateServer(selectedServer);
                    setMessage('✓ Authenticated! Connecting...');
                    await registry.connectServer(selectedServer);
                    setMessage('✓ Connected!');
                    // Return to list
                    setViewMode('list');
                    setSelectedServer(null);
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Check for CORS error
            if (msg.includes('CORS') || msg.includes('Failed to fetch') || msg.includes('net::ERR_FAILED')) {
                setMessage('✗ OAuth blocked by CORS. Use "Set API Key" instead.');
            } else {
                setMessage(`✗ ${msg}`);
            }
        } finally {
            processingRef.current = false;
            setLoading(false);
            setTimeout(() => setMessage(''), 5000);
        }
    };

    const handleAddServer = async (url: string) => {
        if (!url.trim()) return;

        setLoading(true);
        setMessage('Adding server...');

        try {
            const server = await registry.addServer({ url: url.trim() });
            setMessage(`✓ Added ${server.name}`);

            // Check if auth is needed
            const authRequired = await registry.checkAuthRequired(server.id);
            if (authRequired) {
                setMessage(`✓ Added ${server.name} - OAuth required`);
                // Auto-select the new server for configuration
                setSelectedServer(server.id);
                setViewMode('actions');
            } else {
                // Try to connect
                await registry.connectServer(server.id);
                const updated = registry.getServer(server.id);
                setMessage(`✓ Connected! ${updated?.tools.length || 0} tools available`);
                setViewMode('list');
            }
        } catch (e) {
            setMessage(`✗ ${e instanceof Error ? e.message : String(e)}`);
            setViewMode('list');
        } finally {
            setLoading(false);
            setTimeout(() => setMessage(''), 5000);
        }
    };

    const handleSetToken = async (token: string) => {
        if (!selectedServer || !token.trim()) return;

        setLoading(true);
        setMessage('Setting token...');

        try {
            registry.setBearerToken(selectedServer, token.trim());
            setMessage('✓ Token set! Connecting...');

            await registry.connectServer(selectedServer);
            const updated = registry.getServer(selectedServer);
            setMessage(`✓ Connected! ${updated?.tools.length || 0} tools available`);
            setViewMode('list');
            setSelectedServer(null);
        } catch (e) {
            setMessage(`✗ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setLoading(false);
            setTimeout(() => setMessage(''), 5000);
        }
    };

    const server = selectedServer && selectedServer !== '__local__'
        ? registry.getServer(selectedServer)
        : null;
    const isLocalServer = selectedServer === '__local__';
    const mcpData = getMcpStatusData();

    // Build options for select - include local first, then "Add new", then remote servers
    const serverOptions = [
        // Local WASM server (always first)
        ...(mcpData.serverInfo ? [{
            label: `● 📦 ${mcpData.serverInfo.name} v${mcpData.serverInfo.version} (${mcpData.tools.length} tools) [local]`,
            value: '__local__',
        }] : []),
        // Add new option
        { label: '➕ Add new server...', value: '__add__' },
        // Remote servers
        ...servers.map(s => {
            const statusIcon = s.status === 'connected' ? '●' :
                s.status === 'auth_required' ? '🔒' :
                    s.status === 'error' ? '✗' : '○';
            const authBadge = s.bearerToken ? '🔑' : s.authType === 'oauth' ? '' : '';
            return {
                label: `${statusIcon} 🌐 ${s.name} ${authBadge} (${s.tools.length} tools)`,
                value: s.id,
            };
        }),
    ];

    // Actions for remote servers (not local)
    const actionOptions = isLocalServer ? [
        { label: 'ℹ️ View Tools', value: 'view-tools' },
        { label: '← Back', value: 'back' },
    ] : [
        ...(server?.status === 'connected'
            ? [{ label: '⏹ Disconnect', value: 'disconnect' }]
            : [{ label: '🔌 Connect', value: 'connect' }]
        ),
        { label: '🔑 Set API Key', value: 'token' },
        ...(server?.authType === 'oauth' || !server?.bearerToken
            ? [{ label: '🔐 OAuth Login', value: 'auth' }]
            : []
        ),
        { label: '🗑 Remove', value: 'remove' },
        { label: '← Back', value: 'back' },
    ];

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color={colors.cyan} bold>🌐 MCP Servers</Text>

            {viewMode === 'list' && (
                <Box flexDirection="column">
                    <Text color={colors.dim}>
                        {servers.length === 0
                            ? 'No servers. Select "Add new server" to get started.'
                            : '(↑↓ to move, Enter to select, ESC to exit)'}
                    </Text>
                    <Box marginTop={1}>
                        <Select
                            options={serverOptions}
                            onChange={(value) => handleServerSelect(value as string)}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'actions' && isLocalServer && mcpData.serverInfo && (
                <Box flexDirection="column">
                    <Box marginBottom={1}>
                        <Text color={colors.green} bold>📦 {mcpData.serverInfo.name}</Text>
                        <Text color={colors.dim}> v{mcpData.serverInfo.version}</Text>
                    </Box>
                    <Text color={colors.dim}>Built-in WASM sandbox MCP server</Text>
                    <Text color={colors.green}>{mcpData.tools.length} tools available</Text>
                    <Box marginTop={1} flexDirection="column">
                        <Text color={colors.dim}>Tools:</Text>
                        {mcpData.tools.slice(0, 8).map(t => (
                            <Text key={t.name} color={colors.yellow}>  • {t.name}</Text>
                        ))}
                        {mcpData.tools.length > 8 && (
                            <Text color={colors.dim}>  ...and {mcpData.tools.length - 8} more</Text>
                        )}
                    </Box>
                    <Box marginTop={1}>
                        <Text color={colors.dim}>(ESC to go back)</Text>
                    </Box>
                    <Box marginTop={1}>
                        <Select
                            options={actionOptions}
                            defaultValue="back"
                            onChange={async (value) => {
                                if (value === 'back') {
                                    setViewMode('list');
                                    setSelectedServer(null);
                                }
                            }}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'actions' && server && !isLocalServer && (
                <Box flexDirection="column">
                    <Box marginBottom={1}>
                        <Text color={colors.yellow} bold>{server.name}</Text>
                        <Text color={colors.dim}> ({server.status})</Text>
                    </Box>
                    <Text color={colors.dim}>{server.url}</Text>
                    <Text color={colors.dim}>Auth: {server.bearerToken ? 'API Key' : server.authType}</Text>
                    {server.status === 'connected' && (
                        <>
                            <Text color={colors.green}>{server.tools.length} tools available</Text>
                            {server.tools.length > 0 && (
                                <Box marginTop={1} flexDirection="column">
                                    <Text color={colors.dim}>Tools:</Text>
                                    {server.tools.slice(0, 6).map(t => (
                                        <Text key={t.name} color={colors.yellow}>  • {t.name}</Text>
                                    ))}
                                    {server.tools.length > 6 && (
                                        <Text color={colors.dim}>  ...and {server.tools.length - 6} more</Text>
                                    )}
                                </Box>
                            )}
                        </>
                    )}
                    {server.error && (
                        <Text color={colors.red}>Error: {server.error}</Text>
                    )}
                    <Box marginTop={1}>
                        <Text color={colors.dim}>(ESC to go back)</Text>
                    </Box>
                    <Box marginTop={1}>
                        <Select
                            options={actionOptions}
                            defaultValue="back"
                            onChange={(value) => handleAction(value as string)}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'add-server' && (
                <Box flexDirection="column">
                    <Text color={colors.dim}>Enter the MCP server URL (ESC to cancel):</Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>URL: </Text>
                        <TextInput
                            placeholder="https://mcp.example.com"
                            defaultValue=""
                            onSubmit={handleAddServer}
                        />
                    </Box>
                    <Box marginTop={1}>
                        <Text color={colors.dim}>Examples:</Text>
                    </Box>
                    <Text color={colors.dim}>  • https://mcp.stripe.com</Text>
                    <Text color={colors.dim}>  • https://your-server.com/mcp</Text>
                </Box>
            )}

            {viewMode === 'set-token' && server && (
                <Box flexDirection="column">
                    <Text color={colors.yellow} bold>{server.name}</Text>
                    <Text color={colors.dim}>Enter your API key/token (ESC to cancel):</Text>
                    {server.url.includes('stripe.com') && (
                        <Text color={colors.dim}>
                            Get your Stripe key from: https://dashboard.stripe.com/apikeys
                        </Text>
                    )}
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>Token: </Text>
                        <TextInput
                            placeholder="sk_test_... or your-api-key"
                            defaultValue=""
                            onSubmit={handleSetToken}
                        />
                    </Box>
                </Box>
            )}

            {message && (
                <Box marginTop={1}>
                    <Text color={message.startsWith('✓') ? colors.green : message.startsWith('✗') ? colors.red : colors.yellow}>
                        {loading ? '⏳ ' : ''}{message}
                    </Text>
                </Box>
            )}
        </Box>
    );
}

export default McpServerList;
