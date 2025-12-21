/**
 * TextInput Component for ink-web
 * 
 * Wraps @inkjs/ui TextInput with custom prompt styling and tab completion.
 * The underlying @inkjs/ui TextInput handles cursor/arrow key navigation.
 */
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput as InkTextInput } from '@inkjs/ui';

// Completion function type
export type CompletionFn = (input: string) => string[];

export interface TextInputProps {
    value?: string;
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    prompt?: string;
    promptColor?: string;
    focus?: boolean;
    /** Function to get completions for the current input */
    getCompletions?: CompletionFn;
}

export const TextInput = ({
    value: controlledValue,
    onChange,
    onSubmit,
    placeholder = '',
    prompt = '❯ ',
    promptColor = 'cyan',
    focus = true,
    getCompletions,
}: TextInputProps) => {
    const [internalValue, setInternalValue] = useState('');

    const value = controlledValue !== undefined ? controlledValue : internalValue;

    const handleChange = useCallback((newValue: string) => {
        if (controlledValue === undefined) {
            setInternalValue(newValue);
        }
        onChange?.(newValue);
    }, [controlledValue, onChange]);

    const handleSubmit = useCallback((submittedValue: string) => {
        if (submittedValue.trim()) {
            onSubmit?.(submittedValue);
            if (controlledValue === undefined) {
                setInternalValue('');
            }
        }
    }, [controlledValue, onSubmit]);

    // Handle Tab for completion
    useInput((inputChar, key) => {
        if (!focus) return;

        if (key.tab && getCompletions) {
            const completions = getCompletions(value);
            if (completions.length === 1) {
                // Single match - complete it
                const completed = completions[0] + ' ';
                handleChange(completed);
            } else if (completions.length > 1) {
                // Multiple matches - find common prefix
                const common = findCommonPrefix(completions);
                if (common.length > value.length) {
                    handleChange(common);
                }
            }
        }
    });

    return (
        <Box>
            <Text color={promptColor}>{prompt}</Text>
            <InkTextInput
                defaultValue={value}
                placeholder={placeholder}
                isDisabled={!focus}
                onChange={handleChange}
                onSubmit={handleSubmit}
            />
        </Box>
    );
};

// Helper to find common prefix of strings
function findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
        while (!strings[i].startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
            if (prefix === '') return '';
        }
    }
    return prefix;
}

export default TextInput;
