/**
 * Provider Selector Component
 * 
 * Interactive provider configuration using @inkjs/ui Select.
 * Pattern matches McpServerList for consistent UX.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, TextInput } from '@inkjs/ui';
import {
    getAllProviders,
    getCurrentProvider,
    setCurrentProvider,
    hasApiKey,
    getApiKey,
    setApiKey,
    clearApiKey,
    setProviderBaseURL,
    getProviderBaseURL,
    addCustomProvider,
    removeCustomProvider,
    ProviderInfo,
    BUILT_IN_PROVIDERS,
} from '../provider-config';
import { refreshModels } from '../config/ModelDiscovery';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    dim: '#8b949e',
    magenta: '#bc8cff',
};

type ViewMode = 'list' | 'actions' | 'set-key' | 'set-url' | 'add-name' | 'add-url';

interface ProviderSelectorProps {
    onExit: () => void;
    onSelect?: (providerId: string) => void;
}

export function ProviderSelector({ onExit, onSelect }: ProviderSelectorProps) {
    const [viewMode, setViewMode] = useState<ViewMode>('list');
    const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(null);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    const providers = getAllProviders();
    const currentProvider = getCurrentProvider();

    // State for adding new provider
    const [newProviderName, setNewProviderName] = useState('');

    // Handle escape to go back/exit
    useInput((_input, key) => {
        if (key.escape) {
            if (viewMode !== 'list') {
                setViewMode('list');
                setSelectedProvider(null);
                setMessage('');
            } else {
                onExit();
            }
        }
    });

    // Handle provider selection from list
    const handleProviderSelect = (providerId: string) => {
        if (providerId === '__add__') {
            setViewMode('add-name');
            setNewProviderName('');
            return;
        }

        const provider = providers.find(p => p.id === providerId);
        if (provider) {
            setSelectedProvider(provider);
            setViewMode('actions');
        }
    };

    // Handle action selection
    const handleAction = async (action: string) => {
        if (!selectedProvider) return;

        if (action === 'back') {
            setViewMode('list');
            setSelectedProvider(null);
            setMessage('');
            return;
        }

        if (action === 'set-key') {
            setViewMode('set-key');
            return;
        }

        if (action === 'set-url') {
            setViewMode('set-url');
            return;
        }

        if (action === 'clear-key') {
            clearApiKey(selectedProvider.id);
            setMessage('✓ API key cleared');
            setTimeout(() => setMessage(''), 3000);
            return;
        }

        if (action === 'use') {
            setCurrentProvider(selectedProvider.id);
            setMessage(`✓ Switched to ${selectedProvider.name}`);
            onSelect?.(selectedProvider.id);

            // Brief delay then exit
            setTimeout(() => {
                onExit();
            }, 500);
            return;
        }

        if (action === 'refresh-models') {
            if (!hasApiKey(selectedProvider.id)) {
                setMessage('⚠️ Set API key first');
                setTimeout(() => setMessage(''), 3000);
                return;
            }

            setLoading(true);
            setMessage('Fetching models...');
            try {
                const models = await refreshModels(selectedProvider.id);
                setMessage(`✓ Found ${models.length} models`);
            } catch (e) {
                setMessage(`✗ ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                setLoading(false);
                setTimeout(() => setMessage(''), 5000);
            }
        }

        if (action === 'remove') {
            removeCustomProvider(selectedProvider.id);
            setMessage(`✓ Removed ${selectedProvider.name}`);
            setViewMode('list');
            setSelectedProvider(null);
            setTimeout(() => setMessage(''), 3000);
        }
    };

    // Handle key submission
    const handleKeySubmit = (key: string) => {
        if (!selectedProvider) return;

        if (key.trim()) {
            setApiKey(selectedProvider.id, key.trim());
            setMessage('✓ API key saved');
        }
        setViewMode('actions');
        setTimeout(() => setMessage(''), 3000);
    };

    // Handle URL submission
    const handleUrlSubmit = (url: string) => {
        if (!selectedProvider) return;

        setProviderBaseURL(selectedProvider.id, url.trim());
        setMessage(url.trim() ? '✓ Base URL saved' : '✓ Using default URL');
        setViewMode('actions');
        setTimeout(() => setMessage(''), 3000);
    };

    // Handle new provider name submission
    const handleNewNameSubmit = (name: string) => {
        if (!name.trim()) return;
        setNewProviderName(name.trim());
        setViewMode('add-url');
    };

    // Handle new provider URL submission
    const handleNewUrlSubmit = (url: string) => {
        if (!url.trim()) {
            setMessage('⚠️ URL is required');
            setTimeout(() => setMessage(''), 3000);
            return;
        }

        try {
            const id = newProviderName.toLowerCase().replace(/[^a-z0-9]/g, '-');
            const provider = addCustomProvider({
                id,
                name: newProviderName,
                baseURL: url.trim(),
            });
            setMessage(`✓ Added ${provider.name}`);
            setSelectedProvider(provider);
            setViewMode('actions');
        } catch (e) {
            setMessage(`✗ ${e instanceof Error ? e.message : String(e)}`);
            setViewMode('list');
        }
        setTimeout(() => setMessage(''), 3000);
    };

    // Build provider options for Select
    const providerOptions = [
        // Add new option first
        { label: '➕ Add new provider...', value: '__add__' },
        // Then existing providers
        ...providers.map(p => {
            const isCurrent = p.id === currentProvider.id;
            const statusIcon = isCurrent ? '●' : '○';
            const keyIcon = hasApiKey(p.id) ? '🔑' : (p.requiresKey ? '⚠️' : '');
            const isCustom = !BUILT_IN_PROVIDERS.some(bp => bp.id === p.id);
            return {
                label: `${statusIcon} ${p.name} ${keyIcon}${isCustom ? ' [custom]' : ''}`,
                value: p.id,
            };
        }),
    ];

    // Build action options for selected provider
    const getActionOptions = () => {
        if (!selectedProvider) return [];

        const hasKey = hasApiKey(selectedProvider.id);
        const isCurrent = selectedProvider.id === currentProvider.id;
        const customUrl = getProviderBaseURL(selectedProvider.id);
        const isCustom = !BUILT_IN_PROVIDERS.some(bp => bp.id === selectedProvider.id);

        return [
            ...(isCurrent ? [] : [{ label: '✓ Use This Provider', value: 'use' }]),
            { label: '🔑 Set API Key', value: 'set-key' },
            ...(hasKey ? [{ label: '🗑 Clear API Key', value: 'clear-key' }] : []),
            { label: `🔗 Set Base URL${customUrl ? ' ✓' : ''}`, value: 'set-url' },
            ...(hasKey ? [{ label: '🔄 Refresh Models', value: 'refresh-models' }] : []),
            ...(isCustom ? [{ label: '🗑 Remove Provider', value: 'remove' }] : []),
            { label: '← Back', value: 'back' },
        ];
    };

    // Get key display for selected provider
    const getKeyPreview = () => {
        if (!selectedProvider) return '';
        const key = getApiKey(selectedProvider.id);
        if (!key) return 'not set';
        return `...${key.slice(-4)}`;
    };

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color={colors.cyan} bold>🌐 AI Providers</Text>

            {viewMode === 'list' && (
                <Box flexDirection="column">
                    <Text color={colors.dim}>
                        (↑↓ to move, Enter to select, ESC to exit)
                    </Text>
                    <Box marginTop={1}>
                        <Select
                            options={providerOptions}
                            onChange={(value) => handleProviderSelect(value as string)}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'actions' && selectedProvider && (
                <Box flexDirection="column">
                    <Box marginBottom={1}>
                        <Text color={colors.yellow} bold>{selectedProvider.name}</Text>
                        {selectedProvider.id === currentProvider.id && (
                            <Text color={colors.green}> (current)</Text>
                        )}
                    </Box>
                    <Text color={colors.dim}>Type: {selectedProvider.type}</Text>
                    <Text color={colors.dim}>
                        API Key: <Text color={hasApiKey(selectedProvider.id) ? colors.green : colors.yellow}>
                            {hasApiKey(selectedProvider.id) ? getKeyPreview() : 'not set'}
                        </Text>
                    </Text>
                    {getProviderBaseURL(selectedProvider.id) && (
                        <Text color={colors.dim}>
                            URL: {getProviderBaseURL(selectedProvider.id)}
                        </Text>
                    )}
                    <Text color={colors.dim}>{selectedProvider.models.length} models</Text>

                    <Box marginTop={1}>
                        <Text color={colors.dim}>(ESC to go back)</Text>
                    </Box>
                    <Box marginTop={1}>
                        <Select
                            options={getActionOptions()}
                            onChange={(value) => handleAction(value as string)}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'set-key' && selectedProvider && (
                <Box flexDirection="column">
                    <Text color={colors.yellow} bold>{selectedProvider.name}</Text>
                    <Text color={colors.dim}>Enter API key (ESC to cancel):</Text>
                    {hasApiKey(selectedProvider.id) && (
                        <Text color={colors.dim}>Current: {getKeyPreview()}</Text>
                    )}
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>Key: </Text>
                        <TextInput
                            placeholder="sk-... or your-api-key"
                            defaultValue=""
                            onSubmit={handleKeySubmit}
                        />
                    </Box>
                    <Box marginTop={1}>
                        <Text color={colors.yellow}>⚠️ Stored in memory only (lost on refresh)</Text>
                    </Box>
                </Box>
            )}

            {viewMode === 'set-url' && selectedProvider && (
                <Box flexDirection="column">
                    <Text color={colors.yellow} bold>{selectedProvider.name}</Text>
                    <Text color={colors.dim}>Enter base URL (ESC to cancel, blank for default):</Text>
                    <Text color={colors.dim}>
                        Default: {selectedProvider.baseURL || 'https://api.openai.com/v1'}
                    </Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>URL: </Text>
                        <TextInput
                            placeholder="https://api.example.com"
                            defaultValue={getProviderBaseURL(selectedProvider.id) || ''}
                            onSubmit={handleUrlSubmit}
                        />
                    </Box>
                </Box>
            )}

            {viewMode === 'add-name' && (
                <Box flexDirection="column">
                    <Text color={colors.cyan} bold>Add OpenAI-Compatible Provider</Text>
                    <Text color={colors.dim}>Enter a name for this provider (ESC to cancel):</Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>Name: </Text>
                        <TextInput
                            placeholder="Groq, Ollama, Together, etc."
                            defaultValue=""
                            onSubmit={handleNewNameSubmit}
                        />
                    </Box>
                    <Box marginTop={1}>
                        <Text color={colors.dim}>Examples: Groq, Ollama, Together AI, Azure OpenAI</Text>
                    </Box>
                </Box>
            )}

            {viewMode === 'add-url' && (
                <Box flexDirection="column">
                    <Text color={colors.cyan} bold>Add: {newProviderName}</Text>
                    <Text color={colors.dim}>Enter the base URL (ESC to cancel):</Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>URL: </Text>
                        <TextInput
                            placeholder="https://api.groq.com/openai/v1"
                            defaultValue=""
                            onSubmit={handleNewUrlSubmit}
                        />
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                        <Text color={colors.dim}>Examples:</Text>
                        <Text color={colors.dim}>  • https://api.groq.com/openai/v1</Text>
                        <Text color={colors.dim}>  • http://localhost:11434/v1</Text>
                        <Text color={colors.dim}>  • https://api.together.xyz/v1</Text>
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

export default ProviderSelector;
