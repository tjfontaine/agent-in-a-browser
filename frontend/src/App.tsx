/**
 * Web Agent - Main App Component
 * 
 * Typewriter-style TUI using ink-web:
 * - Content fills from top and scrolls up when full
 * - Prompt always stays at the bottom of the viewport
 */

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { InkXterm, Box, Text, useStdout, useInput } from 'ink-web';
import { TextInput } from './components/ui/text-input';
import { TaskPanel } from './components/TaskPanel';
import { useAgent, AgentOutput } from './agent/useAgent';
import { executeCommand, getCommandCompletions } from './commands';
import 'ink-web/css';
import 'xterm/css/xterm.css';

// Colors matching our existing theme
const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    magenta: '#bc8cff',
    dim: '#8b949e',
};

// OutputLine component - memoized to reduce re-renders
const OutputLine = memo(function OutputLine({ output }: { output: AgentOutput }) {
    return (
        <Text color={output.color}>
            {output.content || ' '}
        </Text>
    );
});

// Terminal content component - rendered inside InkXterm
function TerminalContent({
    outputs,
    isReady,
    isBusy,
    queueLength,
    onSubmit,
    getCompletions,
    onCancel,
}: {
    outputs: AgentOutput[];
    isReady: boolean;
    isBusy: boolean;
    queueLength: number;
    onSubmit: (value: string) => void;
    getCompletions: (input: string) => string[];
    onCancel: () => void;
}) {
    // Get terminal dimensions from Ink's stdout
    const { stdout } = useStdout();
    const terminalRows = stdout?.rows ?? 24;

    // Reserve space for prompt (2 lines) and status line when busy

    // Reserve space for prompt (2 lines) and status line when busy
    const statusRows = isBusy ? 1 : 0;
    const promptRows = 2;
    // Add safety buffer (19 lines) to absolutely guarantee no scroll cutoff
    const safetyBuffer = 19;
    // contentRows should never be less than 10 to clear the welcome banner!
    const contentRows = Math.max(10, terminalRows - promptRows - statusRows - safetyBuffer);

    // Show last N outputs only when there's overflow, otherwise show all from top
    const visibleOutputs = outputs.length > contentRows
        ? outputs.slice(-contentRows)
        : outputs;

    // Handle ESC to cancel (more intuitive for browser)
    useInput((_input, key) => {
        if (key.escape && isBusy) {
            onCancel();
        }
        // Also support Ctrl+C
        if (key.ctrl && _input === 'c' && isBusy) {
            onCancel();
        }
    });

    // Build status line
    const statusText = queueLength > 0
        ? `⏳ Agent working... (${queueLength} queued) [ESC to cancel]`
        : `⏳ Agent working... [ESC to cancel]`;

    return (
        <Box
            flexDirection="column"
            height={terminalRows}
            paddingX={1}
        >
            {/* Task panel - fixed at top, outside scrolling area */}
            <TaskPanel />

            {/* Content area - scrolling, shows last N lines */}
            <Box
                flexDirection="column"
                flexGrow={1}
                overflow="hidden"
                justifyContent="flex-start"
            >
                {visibleOutputs.map((output) => (
                    <OutputLine key={output.id} output={output} />
                ))}
            </Box>

            {/* Status line when busy */}
            {isBusy && (
                <Box>
                    <Text color={colors.yellow}>{statusText}</Text>
                </Box>
            )}

            {/* Prompt at bottom - ALWAYS visible when ready (can queue while busy) */}
            {isReady && (
                <TextInput
                    onSubmit={onSubmit}
                    prompt={isBusy ? "📋 " : "❯ "}
                    promptColor={isBusy ? colors.dim : colors.cyan}
                    placeholder={isBusy ? "Type to queue..." : "Type a message or /help..."}
                    focus={true}
                    getCompletions={getCompletions}
                />
            )}
        </Box>
    );
}

// Main App Component
export default function App() {
    const {
        outputs,
        isReady,
        isBusy,
        messageQueue,
        initialize,
        sendMessage,
        queueMessage,
        cancelRequest,
        clearHistory,
        addOutput,
    } = useAgent();

    const initialized = useRef(false);
    const [terminalMounted, setTerminalMounted] = useState(false);

    // Initialize on mount (only once)
    useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;

        // Show welcome banner
        addOutput('system', '╭────────────────────────────────────────────╮', colors.cyan);
        addOutput('system', '│  Web Agent - Browser Edition               │', colors.cyan);
        addOutput('system', '│  Files persist in OPFS sandbox             │', colors.cyan);
        addOutput('system', '│  Type /help for commands                   │', colors.cyan);
        addOutput('system', '╰────────────────────────────────────────────╯', colors.cyan);
        addOutput('system', '', undefined);

        // Start initialization
        initialize();

        // WORKAROUND: Delay terminal mount to mitigate xterm.js issue #5011
        // https://github.com/xtermjs/xterm.js/issues/5011
        const timer = setTimeout(() => setTerminalMounted(true), 200);
        return () => clearTimeout(timer);
    }, [initialize, addOutput]);

    // Cleanup timer if unmounted
    useEffect(() => {
        return () => { };
    }, []);

    // Handle user input - queues if agent is busy
    const handleSubmit = useCallback(async (input: string) => {
        if (!input.trim()) return;

        // Handle slash commands via command handler (always immediate)
        if (input.startsWith('/')) {
            const ctx = {
                output: addOutput,
                clearHistory,
                sendMessage,
            };
            await executeCommand(input, ctx);
            return;
        }

        // Queue if busy, otherwise send immediately
        if (isBusy) {
            queueMessage(input);
        } else {
            sendMessage(input);
        }
    }, [addOutput, clearHistory, sendMessage, isBusy, queueMessage]);

    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
            {/* Terminal taking full space */}
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                {terminalMounted ? (
                    <InkXterm focus>
                        <TerminalContent
                            outputs={outputs}
                            isReady={isReady}
                            isBusy={isBusy}
                            queueLength={messageQueue.length}
                            onSubmit={handleSubmit}
                            getCompletions={getCommandCompletions}
                            onCancel={cancelRequest}
                        />
                    </InkXterm>
                ) : (
                    <div style={{ padding: '12px', color: '#8b949e' }}>Loading terminal...</div>
                )}
            </div>

            {/* Minimal footer if needed, or remove completely. User asked to remove header. */}
        </div>
    );
}
