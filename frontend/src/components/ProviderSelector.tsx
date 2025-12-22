/**
 * ProviderSelector Component
 * 
 * Interactive provider selector using @inkjs/ui Select.
 * Allows switching between AI providers with arrow keys.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import {
    getAllProviders,
    getCurrentProvider,
    setCurrentProvider,
    hasApiKey,
} from '../provider-config';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    dim: '#8b949e',
};

interface ProviderSelectorProps {
    onExit: () => void;
    onSelect?: (providerId: string) => void;
}

export function ProviderSelector({ onExit, onSelect }: ProviderSelectorProps) {
    const currentProvider = getCurrentProvider();
    const providers = getAllProviders();

    // Handle escape to exit
    useInput((_input, key) => {
        if (key.escape) {
            onExit();
        }
    });

    const handleSelect = (providerId: string) => {
        if (providerId === currentProvider.id) {
            // Already selected, just exit
            onExit();
            return;
        }

        setCurrentProvider(providerId);
        onSelect?.(providerId);
        onExit();
    };

    // Build options for select
    const options = providers.map(p => {
        const isCurrent = p.id === currentProvider.id;
        const keyStatus = hasApiKey(p.id) ? '🔑' : (p.requiresKey ? '⚠️' : '✓');
        const aliases = p.aliases.join(', ');
        return {
            label: `${isCurrent ? '●' : '○'} ${p.name} (${aliases}) ${keyStatus} - ${p.models.length} models`,
            value: p.id,
        };
    });

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color={colors.cyan} bold>🌐 Select AI Provider</Text>
            <Text color={colors.dim}>
                Current: {currentProvider.name}
            </Text>
            <Text color={colors.dim}>
                (↑↓ to move, Enter to select, ESC to cancel)
            </Text>
            <Box marginTop={1}>
                <Select
                    options={options}
                    defaultValue={currentProvider.id}
                    onChange={handleSelect}
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

export default ProviderSelector;
