/**
 * ProviderSelector Component
 * 
 * Interactive provider setup with hotkey navigation.
 * Press keys to navigate directly:
 *   [u] - Configure URL
 *   [k] - Configure API key  
 *   [1-9] - Select provider by number
 *   [Enter] - Apply and exit
 *   [Esc] - Cancel
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
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
    magenta: '#bc8cff',
};

type WizardStep = 'menu' | 'configure-url' | 'configure-key';

interface ProviderSelectorProps {
    onExit: () => void;
    onSelect?: (providerId: string) => void;
}

export function ProviderSelector({ onExit, onSelect }: ProviderSelectorProps) {
    const [step, setStep] = useState<WizardStep>('menu');
    const [workingProvider, setWorkingProvider] = useState<ProviderInfo>(getCurrentProvider());
    const [_showKey, setShowKey] = useState(false);

    const providers = getAllProviders();

    // Initialize working state
    const getWorkingUrl = () => getProviderBaseURL(workingProvider.id) || workingProvider.baseURL || '';
    const getWorkingKey = () => getApiKey(workingProvider.id) || '';

    // Handle keyboard input
    useInput((input, key) => {
        // Escape to go back or exit
        if (key.escape) {
            if (step === 'menu') {
                onExit();
            } else {
                setStep('menu');
            }
            return;
        }

        // Only handle hotkeys in menu step
        if (step !== 'menu') {
            if (step === 'configure-key' && input === 't') {
                setShowKey(prev => !prev);
            }
            return;
        }

        // Hotkeys for menu
        const inputLower = input.toLowerCase();

        // [u] - URL configuration
        if (inputLower === 'u') {
            setStep('configure-url');
            return;
        }

        // [k] - Key configuration
        if (inputLower === 'k') {
            setStep('configure-key');
            return;
        }

        // [c] - Clear key
        if (inputLower === 'c') {
            clearApiKey(workingProvider.id);
            return;
        }

        // [Enter] - Apply and exit
        if (key.return) {
            setCurrentProvider(workingProvider.id);
            onSelect?.(workingProvider.id);
            onExit();
            return;
        }

        // [1-9] - Select provider by number
        const num = parseInt(input, 10);
        if (num >= 1 && num <= providers.length) {
            const provider = providers[num - 1];
            setWorkingProvider(provider);
            return;
        }
    });

    // Handle URL submission
    const handleUrlSubmit = (value: string) => {
        const url = value.trim();
        if (url && url !== workingProvider.baseURL) {
            setProviderBaseURL(workingProvider.id, url);
        } else if (!url || url === workingProvider.baseURL) {
            setProviderBaseURL(workingProvider.id, '');
        }
        setStep('menu');
    };

    // Handle key submission
    const handleKeySubmit = (value: string) => {
        const key = value.trim();
        if (key) {
            setApiKey(workingProvider.id, key);
        }
        setStep('menu');
    };

    // Status helpers
    const currentUrl = getProviderBaseURL(workingProvider.id);
    const hasKey = hasApiKey(workingProvider.id);
    const keyInfo = getWorkingKey();
    const keyPreview = keyInfo ? `...${keyInfo.slice(-4)}` : 'not set';

    // ===== MENU STEP =====
    if (step === 'menu') {
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🌐 Provider Configuration</Text>
                <Text color={colors.dim}>Press a key to navigate:</Text>

                {/* Current config display */}
                <Box marginTop={1} flexDirection="column">
                    <Text color={colors.magenta} bold>Current Config:</Text>
                    <Text>  Provider: <Text color={colors.cyan}>{workingProvider.name}</Text></Text>
                    <Text>  Base URL: <Text color={currentUrl ? colors.yellow : colors.dim}>
                        {currentUrl || '(default)'}
                    </Text></Text>
                    <Text>  API Key:  <Text color={hasKey ? colors.green : (workingProvider.requiresKey ? colors.yellow : colors.dim)}>
                        {hasKey ? `✓ Set (${keyPreview})` : (workingProvider.requiresKey ? '⚠️ Not set' : 'Optional')}
                    </Text></Text>
                </Box>

                {/* Hotkey menu */}
                <Box marginTop={1} flexDirection="column">
                    <Text color={colors.magenta} bold>Actions:</Text>
                    <Text>  <Text color={colors.cyan}>[u]</Text> Configure base URL</Text>
                    <Text>  <Text color={colors.cyan}>[k]</Text> Set API key</Text>
                    {hasKey && <Text>  <Text color={colors.cyan}>[c]</Text> Clear API key</Text>}
                    <Text>  <Text color={colors.green}>[Enter]</Text> Apply & exit</Text>
                    <Text>  <Text color={colors.dim}>[Esc]</Text> Cancel</Text>
                </Box>

                {/* Provider selection */}
                <Box marginTop={1} flexDirection="column">
                    <Text color={colors.magenta} bold>Switch Provider:</Text>
                    {providers.map((p, i) => {
                        const isCurrent = p.id === workingProvider.id;
                        const keyStatus = hasApiKey(p.id) ? '🔑' : (p.requiresKey ? '⚠️' : '✓');
                        return (
                            <Text key={p.id}>
                                <Text color={colors.cyan}>[{i + 1}]</Text>
                                <Text color={isCurrent ? colors.green : colors.dim}>
                                    {isCurrent ? ' ● ' : ' ○ '}
                                </Text>
                                <Text color={isCurrent ? colors.green : undefined}>
                                    {p.name} {keyStatus}
                                </Text>
                            </Text>
                        );
                    })}
                </Box>
            </Box>
        );
    }

    // ===== URL STEP =====
    if (step === 'configure-url') {
        const defaultUrl = workingProvider.baseURL || 'https://api.anthropic.com';
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🔗 Configure Base URL</Text>
                <Text color={colors.dim}>Provider: {workingProvider.name}</Text>
                <Text color={colors.dim}>Default: {defaultUrl}</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Enter URL (blank for default):</Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>{'> '}</Text>
                        <TextInput
                            defaultValue={getWorkingUrl() || defaultUrl}
                            onSubmit={handleUrlSubmit}
                        />
                    </Box>
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.dim}>[Enter] Save  [Esc] Cancel</Text>
                </Box>
            </Box>
        );
    }

    // ===== KEY STEP =====
    if (step === 'configure-key') {
        return (
            <Box flexDirection="column" paddingY={1}>
                <Text color={colors.cyan} bold>🔑 Configure API Key</Text>
                <Text color={colors.dim}>Provider: {workingProvider.name}</Text>
                {hasKey && (
                    <Text color={colors.green}>Current: ...{keyInfo.slice(-4)}</Text>
                )}
                <Box marginTop={1} flexDirection="column">
                    <Text>Enter API key:</Text>
                    <Box marginTop={1}>
                        <Text color={colors.cyan}>{'> '}</Text>
                        <TextInput
                            defaultValue=""
                            onSubmit={handleKeySubmit}
                            placeholder="sk-..."
                        />
                    </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    <Text color={colors.dim}>[Enter] Save  [Esc] Cancel</Text>
                    <Text color={colors.yellow}>⚠️ Stored in memory only (lost on refresh)</Text>
                </Box>
            </Box>
        );
    }

    return null;
}

export default ProviderSelector;
