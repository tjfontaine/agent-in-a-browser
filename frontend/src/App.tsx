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
    onSubmit,
    getCompletions,
    onCancel,
}: {
    outputs: AgentOutput[];
    isReady: boolean;
    isBusy: boolean;
    onSubmit: (value: string) => void;
    getCompletions: (input: string) => string[];
    onCancel: () => void;
}) {
    // Get terminal dimensions from Ink's stdout
    const { stdout } = useStdout();
    const terminalRows = stdout?.rows ?? 24;

    // Reserve space for prompt (2 lines) and calculate available content rows
    const promptRows = 2;
    const contentRows = Math.max(1, terminalRows - promptRows);

    // Only show the last N outputs to prevent overflow
    const visibleOutputs = outputs.slice(-contentRows);

    // Handle Ctrl+C to cancel
    useInput((_input, key) => {
        if (key.ctrl && _input === 'c' && isBusy) {
            onCancel();
        }
    });

    return (
        <Box
            flexDirection="column"
            height={terminalRows}
            paddingX={1}
        >
            {/* Content area - fixed height, shows last N lines */}
            <Box
                flexDirection="column"
                height={contentRows}
                overflow="hidden"
            >
                {visibleOutputs.map((output) => (
                    <OutputLine key={output.id} output={output} />
                ))}
            </Box>

            {/* Prompt at bottom - always visible */}
            {isReady && !isBusy && (
                <TextInput
                    onSubmit={onSubmit}
                    prompt="❯ "
                    promptColor={colors.cyan}
                    placeholder="Type a message or /help..."
                    focus={true}
                    getCompletions={getCompletions}
                />
            )}
            {isBusy && (
                <Box>
                    <Text color={colors.yellow}>⏳ Agent is working... (Ctrl+C to cancel)</Text>
                </Box>
            )}
        </Box>
    );
}

// Main App Component
export default function App() {
    const {
        status,
        outputs,
        isReady,
        isBusy,
        initialize,
        sendMessage,
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
        // The xterm Viewport tries to access dimensions before the DOM element
        // is fully rendered, causing "Cannot read dimensions of undefined" errors.
        // 200ms delay gives the container time to establish its dimensions.
        // The errors are harmless but noisy in the console.
        const timer = setTimeout(() => setTerminalMounted(true), 200);
        return () => clearTimeout(timer);
    }, [initialize, addOutput]);

    // Handle user input
    const handleSubmit = useCallback(async (input: string) => {
        if (!input.trim()) return;

        // Handle slash commands via command handler
        if (input.startsWith('/')) {
            const ctx = {
                output: addOutput,
                clearHistory,
                sendMessage,
            };
            await executeCommand(input, ctx);
            return;
        }

        // Send regular messages to agent
        sendMessage(input);
    }, [addOutput, clearHistory, sendMessage]);

    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{
                padding: '12px 16px',
                background: 'linear-gradient(135deg, #16213e 0%, #1a1a2e 100%)',
                borderBottom: '1px solid #333',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
            }}>
                <span style={{ fontSize: '16px', fontWeight: 500, color: '#9d4edd' }}>
                    🤖 Web Agent
                </span>
                <span style={{ fontSize: '12px', color: status.color }}>
                    {status.text}
                </span>
            </div>

            {/* Terminal */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                {terminalMounted ? (
                    <InkXterm focus>
                        <TerminalContent
                            outputs={outputs}
                            isReady={isReady}
                            isBusy={isBusy}
                            onSubmit={handleSubmit}
                            getCompletions={getCommandCompletions}
                            onCancel={cancelRequest}
                        />
                    </InkXterm>
                ) : (
                    <div style={{ padding: '12px', color: '#8b949e' }}>Loading terminal...</div>
                )}
            </div>
        </div>
    );
}
