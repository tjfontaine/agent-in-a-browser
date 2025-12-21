/**
 * TextInput Component for ink-web
 * Based on ink-ui/text-input
 */
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export interface TextInputProps {
    value?: string;
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    prompt?: string;
    promptColor?: string;
    focus?: boolean;
}

export const TextInput = ({
    value: controlledValue,
    onChange,
    onSubmit,
    placeholder = '',
    prompt = '❯ ',
    promptColor = 'cyan',
    focus = true,
}: TextInputProps) => {
    const [internalValue, setInternalValue] = useState('');

    const value = controlledValue !== undefined ? controlledValue : internalValue;
    const setValue = useCallback((newValue: string) => {
        if (controlledValue === undefined) {
            setInternalValue(newValue);
        }
        onChange?.(newValue);
    }, [controlledValue, onChange]);

    useInput((inputChar, key) => {
        if (!focus) return;

        if (key.return) {
            if (value.trim()) {
                onSubmit?.(value);
                if (controlledValue === undefined) {
                    setInternalValue('');
                }
            }
        } else if (key.backspace || key.delete) {
            setValue(value.slice(0, -1));
        } else if (!key.ctrl && !key.meta && inputChar) {
            setValue(value + inputChar);
        }
    });

    const showPlaceholder = !value && placeholder;

    return (
        <Box>
            <Text color={promptColor}>{prompt}</Text>
            {showPlaceholder ? (
                <>
                    <Text dimColor>{placeholder}</Text>
                    {focus && <Text inverse> </Text>}
                </>
            ) : (
                <>
                    <Text>{value}</Text>
                    {focus && <Text inverse> </Text>}
                </>
            )}
        </Box>
    );
};

export default TextInput;
