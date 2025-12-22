/**
 * Web Agent - Main App Component
 * 
 * Typewriter-style TUI using ink-web:
 * - Content fills from top and scrolls up when full
 * - Prompt always stays at the bottom of the viewport
 */

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { InkXterm, Box, Text, useInput } from 'ink-web';
import { TextInput } from './components/ui/text-input';
import { Spinner } from './components/ui/Spinner';
// TEMPORARILY DISABLED - rotating hints cause input issues
// import { useRotatingHints, IDLE_HINTS, BUSY_HINTS } from './components/ui/rotating-hints';
import { SplitLayout, focusAuxPanel } from './components/SplitLayout';
import { AuxiliaryPanel } from './components/AuxiliaryPanel';
import { AuxiliaryPanelProvider } from './components/auxiliary-panel-context';
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



    // Show last 500 outputs for scrollback. xterm handles actual viewport scrolling.
    const maxScrollback = 500;
    const visibleOutputs = outputs.length > maxScrollback
        ? outputs.slice(-maxScrollback)
        : outputs;

    // Handle ESC to cancel, Ctrl+\ to switch panels
    useInput((_input, key) => {
        if (key.escape && isBusy) {
            onCancel();
        }
        // Also support Ctrl+C
        if (key.ctrl && _input === 'c' && isBusy) {
            onCancel();
        }
        // Ctrl+\ sends ASCII 28 (File Separator) in terminals
        if (_input === '\x1c') {
            focusAuxPanel();
        }
    });

    // TEMPORARILY DISABLED: Rotating hints cause re-renders that drop input characters
    // const idleHint = useRotatingHints(IDLE_HINTS, 6000);
    // const busyHint = useRotatingHints(BUSY_HINTS, 5000);
    // const placeholder = isBusy ? busyHint : idleHint;
    const placeholder = isBusy ? 'Type to queue... [ESC to cancel]' : 'Type a message or /help... [Ctrl+\\\\ to switch panels]';

    return (
        <Box
            flexDirection="column"
            flexGrow={1}
            paddingX={1}
        >
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

            {/* Status line when busy - animated spinner */}
            {isBusy && (
                <Box gap={1}>
                    <Spinner />
                    <Text color={colors.yellow}>
                        Agent working...{queueLength > 0 ? ` (${queueLength} queued)` : ''}
                    </Text>
                    <Text color={colors.dim}>[ESC to cancel]</Text>
                </Box>
            )}

            {/* Prompt at bottom - ALWAYS visible when ready (can queue while busy) */}
            {isReady && (
                <TextInput
                    onSubmit={onSubmit}
                    prompt={isBusy ? "📋 " : "❯ "}
                    promptColor={isBusy ? colors.dim : colors.cyan}
                    placeholder={placeholder}
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
        status,
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
        <AuxiliaryPanelProvider>
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

                {/* Split Terminal Layout */}
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                    {terminalMounted ? (
                        <SplitLayout
                            auxiliaryPanel={<AuxiliaryPanel />}
                            mainPanel={
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
                            }
                        />
                    ) : (
                        <div style={{ padding: '12px', color: '#8b949e' }}>Loading terminal...</div>
                    )}
                </div>

            </div>
        </AuxiliaryPanelProvider>
    );
}
