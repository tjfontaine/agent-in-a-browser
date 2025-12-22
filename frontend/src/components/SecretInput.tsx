/**
 * SecretInput Component
 * 
 * Password-style input for API keys and other sensitive data.
 * Masks input characters as dots for security.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    dim: '#8b949e',
};

interface SecretInputProps {
    label: string;
    placeholder?: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}

export function SecretInput({ label, placeholder, onSubmit, onCancel }: SecretInputProps) {
    const [value, setValue] = useState('');
    const [showCursor, setShowCursor] = useState(true);

    // Blink cursor
    React.useEffect(() => {
        const interval = setInterval(() => {
            setShowCursor(prev => !prev);
        }, 500);
        return () => clearInterval(interval);
    }, []);

    useInput((input, key) => {
        if (key.escape) {
            onCancel();
            return;
        }

        if (key.return) {
            if (value.length > 0) {
                onSubmit(value);
            }
            return;
        }

        if (key.backspace || key.delete) {
            setValue(prev => prev.slice(0, -1));
            return;
        }

        // Only accept printable characters
        if (input && input.length === 1 && !key.ctrl && !key.meta) {
            setValue(prev => prev + input);
        }
    });

    // Mask the value with dots
    const maskedValue = '•'.repeat(value.length);
    const cursor = showCursor ? '▌' : ' ';

    return (
        <Box flexDirection="column" paddingY={1}>
            <Text color={colors.cyan} bold>🔑 {label}</Text>

            {placeholder && value.length === 0 && (
                <Text color={colors.dim}>{placeholder}</Text>
            )}

            <Box marginTop={1}>
                <Text color={colors.yellow}>{'> '}</Text>
                <Text>{maskedValue}</Text>
                <Text color={colors.cyan}>{cursor}</Text>
            </Box>

            <Box marginTop={1}>
                <Text color={colors.dim}>
                    {value.length > 0
                        ? `${value.length} characters • Enter to confirm • ESC to cancel`
                        : 'Paste or type your API key • ESC to cancel'
                    }
                </Text>
            </Box>
        </Box>
    );
}

export default SecretInput;
