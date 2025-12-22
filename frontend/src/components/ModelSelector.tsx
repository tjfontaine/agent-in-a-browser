/**
 * ModelSelector Component
 * 
 * Interactive model selector using @inkjs/ui Select.
 * Allows switching between AI models with arrow keys.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import {
    getModelsForCurrentProvider,
    getCurrentModel,
    setCurrentModel,
    getCurrentModelInfo,
    getCurrentProvider,
} from '../provider-config';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    dim: '#8b949e',
};

interface ModelSelectorProps {
    onExit: () => void;
    onSelect?: (modelId: string) => void;
}

export function ModelSelector({ onExit, onSelect }: ModelSelectorProps) {
    const currentModelId = getCurrentModel();
    const provider = getCurrentProvider();
    const models = getModelsForCurrentProvider();

    // Handle escape to exit
    useInput((_input, key) => {
        if (key.escape) {
            onExit();
        }
    });

    const handleSelect = (modelId: string) => {
        if (modelId === currentModelId) {
            // Already selected, just exit
            onExit();
            return;
        }

        setCurrentModel(modelId);
        onSelect?.(modelId);
        onExit();
    };

    // Build options for select
    const options = models.map(m => {
        const isCurrent = m.id === currentModelId;
        const aliases = m.aliases.join(', ');
        return {
            label: `${isCurrent ? '●' : '○'} ${m.name} (${aliases}) - ${m.description}`,
            value: m.id,
        };
    });

    const currentInfo = getCurrentModelInfo();

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color={colors.cyan} bold>🤖 Select {provider.name} Model</Text>
            <Text color={colors.dim}>
                Current: {currentInfo?.name || currentModelId}
            </Text>
            <Text color={colors.dim}>
                (↑↓ to move, Enter to select, ESC to cancel)
            </Text>
            <Box marginTop={1}>
                <Select
                    options={options}
                    defaultValue={currentModelId}
                    onChange={handleSelect}
                />
            </Box>
        </Box>
    );
}

export default ModelSelector;

