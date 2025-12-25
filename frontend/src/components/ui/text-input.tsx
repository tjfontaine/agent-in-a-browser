/**
 * TextInput Component for ink-web
 * 
 * Full-featured text input with:
 * - Readline keybindings (Ctrl+A/E/W/U/K)
 * - Arrow key cursor navigation
 * - Command history (up/down arrows)
 * - Ctrl+R for reverse-i-search
 * - Tab completion
 * - Paste support (Ctrl+V / browser paste)
 * - Persistent history (survives page reloads)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
    getCommandHistory,
    addToHistory,
    searchHistory,
} from './command-history';

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

// Reference to shared command history
const commandHistory = getCommandHistory();

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
    const [cursorPosition, setCursorPosition] = useState(0);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [cursorVisible, setCursorVisible] = useState(true);
    const savedInputRef = useRef('');  // Save input when browsing history

    // Reverse-i-search state
    const [isSearching, setIsSearching] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchMatch, setSearchMatch] = useState<string | null>(null);
    const [searchMatchIndex, setSearchMatchIndex] = useState(-1);

    // Blink cursor effect
    useEffect(() => {
        if (!focus) return;
        const interval = setInterval(() => {
            setCursorVisible(v => !v);
        }, 530); // Standard terminal blink rate
        return () => clearInterval(interval);
    }, [focus]);

    const value = controlledValue !== undefined ? controlledValue : internalValue;

    const setValue = useCallback((newValue: string, newCursor?: number) => {
        if (controlledValue === undefined) {
            setInternalValue(newValue);
        }
        onChange?.(newValue);
        setCursorPosition(newCursor !== undefined ? newCursor : newValue.length);
    }, [controlledValue, onChange]);

    // Handle paste events from browser AND keyboard (Ctrl+V/Cmd+V)
    // xterm.js intercepts keyboard events before they trigger native paste,
    // so we need to handle both the paste event and explicit Ctrl+V/Cmd+V
    useEffect(() => {
        if (!focus) return;

        const insertText = (text: string) => {
            // Insert at cursor position
            const before = value.slice(0, cursorPosition);
            const after = value.slice(cursorPosition);
            const newValue = before + text + after;
            const newCursor = cursorPosition + text.length;
            setValue(newValue, newCursor);
        };

        const handlePaste = (e: ClipboardEvent) => {
            const pastedText = e.clipboardData?.getData('text');
            if (pastedText) {
                insertText(pastedText);
                e.preventDefault();
            }
        };

        // Handle Ctrl+V / Cmd+V keyboard events explicitly
        // This is needed because xterm.js captures the keystroke before paste fires
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault();
                e.stopPropagation();

                // Read from clipboard API
                navigator.clipboard.readText().then((text) => {
                    if (text) {
                        insertText(text);
                    }
                }).catch((err) => {
                    console.warn('[TextInput] Clipboard read failed:', err);
                });
            }
        };

        window.addEventListener('paste', handlePaste);
        window.addEventListener('keydown', handleKeyDown, true); // capture phase
        return () => {
            window.removeEventListener('paste', handlePaste);
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [focus, value, cursorPosition, setValue]);

    useInput((inputChar, key) => {
        if (!focus) return;

        // Handle reverse-i-search mode
        if (isSearching) {
            // ESC to cancel search
            if (key.escape) {
                setIsSearching(false);
                setSearchQuery('');
                setSearchMatch(null);
                setSearchMatchIndex(-1);
                return;
            }

            // Enter to accept current match
            if (key.return) {
                if (searchMatch) {
                    setValue(searchMatch, searchMatch.length);
                }
                setIsSearching(false);
                setSearchQuery('');
                setSearchMatch(null);
                setSearchMatchIndex(-1);
                return;
            }

            // Ctrl+R again to search further back
            if (key.ctrl && inputChar === 'r') {
                if (searchMatchIndex > 0) {
                    const result = searchHistory(searchQuery, searchMatchIndex);
                    if (result) {
                        setSearchMatch(result.match);
                        setSearchMatchIndex(result.index);
                    }
                }
                return;
            }

            // Backspace in search mode
            if (key.backspace || key.delete) {
                const newQuery = searchQuery.slice(0, -1);
                setSearchQuery(newQuery);
                // Re-search with shorter query
                if (newQuery) {
                    const result = searchHistory(newQuery);
                    if (result) {
                        setSearchMatch(result.match);
                        setSearchMatchIndex(result.index);
                    } else {
                        setSearchMatch(null);
                        setSearchMatchIndex(-1);
                    }
                } else {
                    setSearchMatch(null);
                    setSearchMatchIndex(-1);
                }
                return;
            }

            // Regular character input in search mode
            if (!key.ctrl && !key.meta && inputChar && inputChar.length === 1) {
                const newQuery = searchQuery + inputChar;
                setSearchQuery(newQuery);
                // Search backwards through history
                const result = searchHistory(newQuery);
                if (result) {
                    setSearchMatch(result.match);
                    setSearchMatchIndex(result.index);
                } else {
                    setSearchMatch(null);
                    setSearchMatchIndex(-1);
                }
            }
            return;
        }

        // Ctrl+R - Enter reverse-i-search mode
        if (key.ctrl && inputChar === 'r') {
            savedInputRef.current = value;
            setIsSearching(true);
            setSearchQuery('');
            setSearchMatch(null);
            setSearchMatchIndex(-1);
            return;
        }

        // Submit on Enter
        if (key.return) {
            if (value.trim()) {
                // Add to history using the history module
                addToHistory(value);

                onSubmit?.(value);
                if (controlledValue === undefined) {
                    setInternalValue('');
                }
                setCursorPosition(0);
                setHistoryIndex(-1);
                savedInputRef.current = '';
            }
            return;
        }

        // Tab - Complete command
        if (key.tab && getCompletions) {
            const completions = getCompletions(value);
            if (completions.length === 1) {
                setValue(completions[0] + ' ', completions[0].length + 1);
            } else if (completions.length > 1) {
                const common = findCommonPrefix(completions);
                if (common.length > value.length) {
                    setValue(common, common.length);
                }
            }
            return;
        }

        // Up arrow - History previous
        if (key.upArrow) {
            if (commandHistory.length === 0) return;

            if (historyIndex === -1) {
                // Save current input before browsing history
                savedInputRef.current = value;
            }

            const newIndex = historyIndex === -1
                ? commandHistory.length - 1
                : Math.max(0, historyIndex - 1);

            setHistoryIndex(newIndex);
            const historyValue = commandHistory[newIndex];
            setValue(historyValue, historyValue.length);
            return;
        }

        // Down arrow - History next
        if (key.downArrow) {
            if (historyIndex === -1) return;

            const newIndex = historyIndex + 1;
            if (newIndex >= commandHistory.length) {
                // Restore saved input
                setHistoryIndex(-1);
                setValue(savedInputRef.current, savedInputRef.current.length);
            } else {
                setHistoryIndex(newIndex);
                const historyValue = commandHistory[newIndex];
                setValue(historyValue, historyValue.length);
            }
            return;
        }

        // Ctrl+A - Move to start of line
        if (key.ctrl && inputChar === 'a') {
            setCursorPosition(0);
            return;
        }

        // Ctrl+E - Move to end of line
        if (key.ctrl && inputChar === 'e') {
            setCursorPosition(value.length);
            return;
        }

        // Ctrl+U - Clear line before cursor
        if (key.ctrl && inputChar === 'u') {
            setValue(value.slice(cursorPosition), 0);
            return;
        }

        // Ctrl+K - Clear line after cursor
        if (key.ctrl && inputChar === 'k') {
            setValue(value.slice(0, cursorPosition), cursorPosition);
            return;
        }

        // Ctrl+W - Delete word backwards
        if (key.ctrl && inputChar === 'w') {
            const beforeCursor = value.slice(0, cursorPosition);
            const afterCursor = value.slice(cursorPosition);
            const trimmed = beforeCursor.trimEnd();
            const lastSpace = trimmed.lastIndexOf(' ');
            const newBefore = lastSpace === -1 ? '' : beforeCursor.slice(0, lastSpace + 1);
            setValue(newBefore + afterCursor, newBefore.length);
            return;
        }

        // Left arrow - Move cursor left
        if (key.leftArrow) {
            setCursorPosition(Math.max(0, cursorPosition - 1));
            return;
        }

        // Right arrow - Move cursor right
        if (key.rightArrow) {
            setCursorPosition(Math.min(value.length, cursorPosition + 1));
            return;
        }

        // Backspace - Delete character before cursor
        if (key.backspace || key.delete) {
            if (cursorPosition > 0) {
                const newValue = value.slice(0, cursorPosition - 1) + value.slice(cursorPosition);
                setValue(newValue, cursorPosition - 1);
            }
            return;
        }

        // Regular character input
        if (!key.ctrl && !key.meta && inputChar && inputChar.length === 1) {
            const newValue = value.slice(0, cursorPosition) + inputChar + value.slice(cursorPosition);
            setValue(newValue, cursorPosition + 1);
            // Reset history browsing on new input
            if (historyIndex !== -1) {
                setHistoryIndex(-1);
                savedInputRef.current = '';
            }
        }
    });

    // Render reverse-i-search mode
    if (isSearching) {
        const displayText = searchMatch || '';
        return (
            <Box flexWrap="wrap">
                <Text color="yellow">(reverse-i-search)`</Text>
                <Text bold>{searchQuery}</Text>
                <Text color="yellow">': </Text>
                <Text>{displayText}</Text>
                {focus && cursorVisible && (
                    <Text backgroundColor="white" color="black"> </Text>
                )}
            </Box>
        );
    }

    const showPlaceholder = !value && placeholder;
    const beforeCursor = value.slice(0, cursorPosition);
    const atCursor = value[cursorPosition] || ' ';
    const afterCursor = value.slice(cursorPosition + 1);

    // For cursor, always show a space with white background - simpler and consistent
    // Don't use the block character as it renders inconsistently with inverse

    return (
        <Box flexWrap="wrap">
            <Text color={promptColor}>{prompt}</Text>
            {showPlaceholder ? (
                <>
                    {focus && cursorVisible ? (
                        <Text backgroundColor="white" color="black"> </Text>
                    ) : <Text> </Text>}
                    <Text dimColor>{placeholder}</Text>
                </>
            ) : (
                <>
                    <Text>{beforeCursor}</Text>
                    {focus && cursorVisible ? (
                        <Text backgroundColor="white" color="black">{atCursor === ' ' ? ' ' : atCursor}</Text>
                    ) : (
                        <Text>{atCursor}</Text>
                    )}
                    <Text>{afterCursor}</Text>
                </>
            )}
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
