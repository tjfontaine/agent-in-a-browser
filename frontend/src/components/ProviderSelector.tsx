/**
 * ProviderSelector Component
 * 
 * Interactive multi-step provider setup wizard using @inkjs/ui.
 * Steps:
 * 1. Select provider
 * 2. Configure base URL (optional override)
 * 3. Set API key (if required)
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
    ProviderInfo,
} from '../provider-config';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    dim: '#8b949e',
};

type WizardStep = 'select-provider' | 'configure-url' | 'configure-key' | 'summary';

interface ProviderSelectorProps {
    onExit: () => void;
    onSelect?: (providerId: string) => void;
}

export function ProviderSelector({ onExit, onSelect }: ProviderSelectorProps) {
    const [step, setStep] = useState<WizardStep>('select-provider');
    const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(null);
    const [customUrl, setCustomUrl] = useState('');
    const [apiKey, setApiKeyValue] = useState('');
    const [showKey, setShowKey] = useState(false);

    const currentProvider = getCurrentProvider();
    const providers = getAllProviders();

    // Handle escape to exit at any step
    useInput((input, key) => {
        if (key.escape) {
            onExit();
        }
        // Toggle show/hide key in key step
        if (step === 'configure-key' && input === 't') {
            setShowKey(prev => !prev);
        }
    });

    // Step 1: Select Provider
    const handleProviderSelect = (providerId: string) => {
        const provider = providers.find(p => p.id === providerId);
        if (!provider) return;

        setSelectedProvider(provider);
        // Pre-fill with existing values
        setCustomUrl(getProviderBaseURL(providerId) || provider.baseURL || '');
        setApiKeyValue(getApiKey(providerId) || '');
        setStep('configure-url');
    };

    // Step 2: Configure Base URL
    const handleUrlSubmit = (value: string) => {
        const url = value.trim();
        if (selectedProvider) {
            if (url && url !== selectedProvider.baseURL) {
                setProviderBaseURL(selectedProvider.id, url);
            } else if (!url || url === selectedProvider.baseURL) {
                // Clear override if empty or same as default
                setProviderBaseURL(selectedProvider.id, '');
            }
        }
        setStep('configure-key');
    };

    const _handleUrlSkip = () => {
        setStep('configure-key');
    };

    // Step 3: Configure API Key
    const handleKeySubmit = (value: string) => {
        const key = value.trim();
        if (selectedProvider) {
            if (key) {
                setApiKey(selectedProvider.id, key);
            }
        }
        setStep('summary');
    };

    const _handleKeyClear = () => {
        if (selectedProvider) {
            clearApiKey(selectedProvider.id);
            setApiKeyValue('');
        }
    };

    // Final: Apply and exit
    const handleFinish = () => {
        if (selectedProvider) {
            setCurrentProvider(selectedProvider.id);
            onSelect?.(selectedProvider.id);
        }
        onExit();
    };

    // Build provider options - with "Configure current" at top
    const providerOptions = [
        // Add "Configure current provider" option at top
        {
            label: `⚙️  Configure ${currentProvider.name} (current)`,
            value: `__configure__${currentProvider.id}`,
        },
        // Then all providers
        ...providers.map(p => {
            const isCurrent = p.id === currentProvider.id;
            const keyStatus = hasApiKey(p.id) ? '🔑' : (p.requiresKey ? '⚠️' : '✓');
            const aliases = p.aliases.join(', ');
            return {
                label: `${isCurrent ? '●' : '○'} ${p.name} (${aliases}) ${keyStatus}`,
                value: p.id,
            };
        }),
    ];

    // Handle selection - check for configure action
    const handleMenuSelect = (value: string) => {
        if (value.startsWith('__configure__')) {
            // Configure current provider - skip to URL step
            const providerId = value.replace('__configure__', '');
            const provider = providers.find(p => p.id === providerId);
            if (provider) {
                setSelectedProvider(provider);
                setCustomUrl(getProviderBaseURL(providerId) || provider.baseURL || '');
                setApiKeyValue(getApiKey(providerId) || '');
                setStep('configure-url');
            }
        } else {
            handleProviderSelect(value);
        }
    };

    // Render based on current step
    if (step === 'select-provider') {
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🌐 Step 1/3: Select AI Provider</Text>
                <Text color={colors.dim}>
                    Current: {currentProvider.name}
                </Text>
                <Text color={colors.dim}>
                    (↑↓ to move, Enter to select, ESC to cancel)
                </Text>
                <Box marginTop={1}>
                    <Select
                        options={providerOptions}
                        defaultValue={`__configure__${currentProvider.id}`}
                        onChange={handleMenuSelect}
                    />
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.dim}>
                        🔑 = key set, ⚠️ = key needed, ✓ = no key required
                    </Text>
                </Box>
            </Box>
        );
    }

    if (step === 'configure-url' && selectedProvider) {
        const defaultUrl = selectedProvider.baseURL || 'https://api.anthropic.com';
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🔗 Step 2/3: Configure Base URL</Text>
                <Text color={colors.dim}>
                    Provider: {selectedProvider.name}
                </Text>
                <Text color={colors.dim}>
                    Default: {defaultUrl}
                </Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Enter custom URL (or press Enter to use default):</Text>
                    <Box marginTop={1}>
                        <TextInput
                            defaultValue={customUrl || defaultUrl}
                            onSubmit={handleUrlSubmit}
                            placeholder={defaultUrl}
                        />
                    </Box>
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.dim}>
                        Press Enter to continue, ESC to cancel
                    </Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.yellow}>
                        💡 Tip: Use custom URLs for local proxies or OpenAI-compatible APIs
                    </Text>
                </Box>
            </Box>
        );
    }

    if (step === 'configure-key' && selectedProvider) {
        const existingKey = getApiKey(selectedProvider.id);
        const maskedKey = apiKey ? '•'.repeat(Math.min(apiKey.length, 20)) + (apiKey.length > 20 ? '...' : '') : '';

        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🔑 Step 3/3: Configure API Key</Text>
                <Text color={colors.dim}>
                    Provider: {selectedProvider.name}
                </Text>
                {existingKey && (
                    <Text color={colors.green}>
                        ✓ Existing key stored (ends with ...{existingKey.slice(-4)})
                    </Text>
                )}
                {!selectedProvider.requiresKey && (
                    <Text color={colors.yellow}>
                        ⓘ This provider works without an API key (uses backend proxy)
                    </Text>
                )}
                <Box marginTop={1} flexDirection="column">
                    <Text>
                        {existingKey ? 'Enter new key to replace, or press Enter to keep:' : 'Enter API key:'}
                    </Text>
                    <Box marginTop={1}>
                        {showKey ? (
                            <TextInput
                                defaultValue={apiKey}
                                onSubmit={handleKeySubmit}
                                placeholder="sk-..."
                            />
                        ) : (
                            <Box>
                                <Text>{maskedKey || '(paste key here)'}</Text>
                                <TextInput
                                    defaultValue=""
                                    onSubmit={(v) => {
                                        setApiKeyValue(v);
                                        handleKeySubmit(v);
                                    }}
                                    placeholder=""
                                />
                            </Box>
                        )}
                    </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    <Text color={colors.dim}>
                        Press Enter to continue, ESC to cancel
                    </Text>
                    <Text color={colors.dim}>
                        Press 't' to toggle show/hide key
                    </Text>
                    {existingKey && (
                        <Text color={colors.dim}>
                            Type 'clear' and press Enter to remove stored key
                        </Text>
                    )}
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.yellow}>
                        ⚠️ Keys are stored in memory only - lost on page refresh
                    </Text>
                </Box>
            </Box>
        );
    }

    if (step === 'summary' && selectedProvider) {
        const finalUrl = getProviderBaseURL(selectedProvider.id) || selectedProvider.baseURL || 'default';
        const hasKey = hasApiKey(selectedProvider.id);

        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.green} bold>✓ Provider Configuration Complete</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Provider: <Text color={colors.cyan}>{selectedProvider.name}</Text></Text>
                    <Text>Base URL: <Text color={colors.dim}>{finalUrl}</Text></Text>
                    <Text>API Key:  <Text color={hasKey ? colors.green : (selectedProvider.requiresKey ? colors.yellow : colors.dim)}>
                        {hasKey ? '✓ Set' : (selectedProvider.requiresKey ? '⚠️ Not set' : 'Not required')}
                    </Text></Text>
                    <Text>Models:   <Text color={colors.dim}>{selectedProvider.models.length} available</Text></Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.dim}>
                        Press Enter to apply, ESC to cancel
                    </Text>
                </Box>
                <Box marginTop={1}>
                    <Select
                        options={[
                            { label: '✓ Apply and use this provider', value: 'apply' },
                            { label: '← Back to URL configuration', value: 'back-url' },
                            { label: '← Back to provider selection', value: 'back-provider' },
                        ]}
                        onChange={(choice) => {
                            if (choice === 'apply') handleFinish();
                            else if (choice === 'back-url') setStep('configure-url');
                            else if (choice === 'back-provider') setStep('select-provider');
                        }}
                    />
                </Box>
            </Box>
        );
    }

    return null;
}

export default ProviderSelector;
