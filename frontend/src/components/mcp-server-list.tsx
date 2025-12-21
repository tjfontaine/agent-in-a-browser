/**
 * MCP Server List Component
 * 
 * Interactive list for managing MCP servers using @inkjs/ui Select.
 * Supports connect/disconnect/remove actions.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import { getRemoteMCPRegistry, RemoteMCPServer } from '../remote-mcp-registry';

interface McpServerListProps {
    onExit: () => void;
    onAction?: (action: string, serverId: string) => Promise<void>;
}

export function McpServerList({ onExit, onAction }: McpServerListProps) {
    const [servers, setServers] = useState<RemoteMCPServer[]>([]);
    const [selectedServer, setSelectedServer] = useState<string | null>(null);
    const [actionMode, setActionMode] = useState(false);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    const registry = getRemoteMCPRegistry();

    // Load servers
    useEffect(() => {
        setServers(registry.getServers());
        const unsub = registry.subscribe(() => {
            setServers(registry.getServers());
        });
        return unsub;
    }, [registry]);

    // Handle escape to exit
    useInput((input, key) => {
        if (key.escape) {
            if (actionMode) {
                setActionMode(false);
                setSelectedServer(null);
            } else {
                onExit();
            }
        }
    });

    const handleServerSelect = (serverId: string) => {
        setSelectedServer(serverId);
        setActionMode(true);
    };

    const handleAction = async (action: string) => {
        if (!selectedServer) return;

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
                } else if (action === 'disconnect') {
                    await registry.disconnectServer(selectedServer);
                    setMessage('✓ Disconnected');
                } else if (action === 'remove') {
                    await registry.removeServer(selectedServer);
                    setMessage('✓ Removed');
                    setSelectedServer(null);
                    setActionMode(false);
                }
            }
        } catch (e) {
            setMessage(`✗ Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setLoading(false);
            setTimeout(() => setMessage(''), 3000);
        }
    };

    if (servers.length === 0) {
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color="cyan">MCP Servers</Text>
                <Text dimColor>No servers configured. Use /mcp add &lt;url&gt;</Text>
                <Text dimColor>Press ESC to exit</Text>
            </Box>
        );
    }

    // Build options for select
    const serverOptions = servers.map(s => ({
        label: `${s.status === 'connected' ? '●' : '○'} ${s.name} (${s.id}) - ${s.tools.length} tools`,
        value: s.id,
    }));

    const actionOptions = [
        { label: '🔌 Connect', value: 'connect' },
        { label: '⏹ Disconnect', value: 'disconnect' },
        { label: '🗑 Remove', value: 'remove' },
        { label: '← Back', value: 'back' },
    ];

    const server = selectedServer ? registry.getServer(selectedServer) : null;

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color="cyan" bold>MCP Servers</Text>

            {!actionMode ? (
                <Box flexDirection="column">
                    <Text dimColor>Select a server (↑↓ to move, Enter to select, ESC to exit)</Text>
                    <Box marginTop={1}>
                        <Select
                            options={serverOptions}
                            onChange={(value) => handleServerSelect(value as string)}
                        />
                    </Box>
                </Box>
            ) : (
                <Box flexDirection="column">
                    <Text>
                        <Text color="yellow">{server?.name}</Text>
                        <Text dimColor> ({server?.status})</Text>
                    </Text>
                    <Text dimColor>Choose an action (ESC to go back)</Text>
                    <Box marginTop={1}>
                        <Select
                            options={actionOptions}
                            onChange={async (value) => {
                                if (value === 'back') {
                                    setActionMode(false);
                                    setSelectedServer(null);
                                } else {
                                    await handleAction(value as string);
                                }
                            }}
                        />
                    </Box>
                </Box>
            )}

            {message && (
                <Box marginTop={1}>
                    <Text color={message.startsWith('✓') ? 'green' : message.startsWith('✗') ? 'red' : 'yellow'}>
                        {loading ? '⏳ ' : ''}{message}
                    </Text>
                </Box>
            )}
        </Box>
    );
}

export default McpServerList;
