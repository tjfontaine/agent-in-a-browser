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
import { ModelSelector } from './components/ModelSelector';
import { ProviderSelector } from './components/ProviderSelector';
import { SecretInput } from './components/SecretInput';
import { useAgent, AgentOutput } from './agent/useAgent';
import { executeCommand, getCommandCompletions } from './commands';
import {
    getCurrentProvider,
    getConfigSummary,
    setApiKey,
    hasApiKey,
    subscribeToChanges,
} from './provider-config';
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

// Overlay mode types
type OverlayMode = 'none' | 'model-selector' | 'provider-selector' | 'secret-input';

interface SecretInputState {
    providerId: string;
    providerName: string;
    pendingMessage?: string; // Message to dispatch after API key is set
}

// Terminal content component - rendered inside InkXterm
function TerminalContent({
    outputs,
    isReady,
    isBusy,
    queueLength,
    overlayMode,
    secretInputState,
    onSubmit,
    getCompletions,
    onCancel,
    onOverlayClose,
    onModelSelected,
    onProviderSelected,
    onSecretSubmit,
}: {
    outputs: AgentOutput[];
    isReady: boolean;
    isBusy: boolean;
    queueLength: number;
    overlayMode: OverlayMode;
    secretInputState: SecretInputState | null;
    onSubmit: (value: string) => void;
    getCompletions: (input: string) => string[];
    onCancel: () => void;
    onOverlayClose: () => void;
    onModelSelected: (modelId: string) => void;
    onProviderSelected: (providerId: string) => void;
    onSecretSubmit: (value: string) => void;
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

            {/* Overlay components OR prompt at bottom */}
            {overlayMode === 'model-selector' ? (
                <ModelSelector
                    onExit={onOverlayClose}
                    onSelect={onModelSelected}
                />
            ) : overlayMode === 'provider-selector' ? (
                <ProviderSelector
                    onExit={onOverlayClose}
                    onSelect={onProviderSelected}
                />
            ) : overlayMode === 'secret-input' && secretInputState ? (
                <SecretInput
                    label={`Enter API key for ${secretInputState.providerName}`}
                    placeholder="Paste your API key here..."
                    onSubmit={onSecretSubmit}
                    onCancel={onOverlayClose}
                />
            ) : (
                /* Prompt at bottom - ALWAYS visible when ready (can queue while busy) */
                isReady && (
                    <TextInput
                        onSubmit={onSubmit}
                        prompt={isBusy ? "📋 " : "❯ "}
                        promptColor={isBusy ? colors.dim : colors.cyan}
                        placeholder={placeholder}
                        focus={true}
                        getCompletions={getCompletions}
                    />
                )
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
    const [overlayMode, setOverlayMode] = useState<OverlayMode>('none');
    const [secretInputState, setSecretInputState] = useState<SecretInputState | null>(null);
    const [configSummary, setConfigSummary] = useState(getConfigSummary());

    // Subscribe to provider/model changes
    useEffect(() => {
        return subscribeToChanges(() => {
            setConfigSummary(getConfigSummary());
        });
    }, []);

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
            // Special case: /model with no args shows interactive selector
            if (input.trim() === '/model') {
                setOverlayMode('model-selector');
                return;
            }
            // Special case: /provider with no args shows interactive selector
            if (input.trim() === '/provider' || input.trim() === '/p') {
                setOverlayMode('provider-selector');
                return;
            }

            const ctx = {
                output: (type: 'text' | 'tool-start' | 'tool-result' | 'error' | 'system', content: string, color?: string) => {
                    // Check for secret input signal
                    if (content.startsWith('__SHOW_SECRET_INPUT__:')) {
                        const parts = content.split(':');
                        setSecretInputState({ providerId: parts[1], providerName: parts[2] });
                        setOverlayMode('secret-input');
                        return;
                    }
                    addOutput(type, content, color);
                },
                clearHistory,
                // Wrap sendMessage to check API key requirements (same as regular messages)
                sendMessage: (msg: string) => {
                    const provider = getCurrentProvider();
                    if (provider.requiresKey && !hasApiKey(provider.id)) {
                        addOutput('system', `⚠️ API key required for ${provider.name}`, colors.yellow);
                        // Store the pending message to dispatch after API key is set
                        setSecretInputState({ providerId: provider.id, providerName: provider.name, pendingMessage: msg });
                        setOverlayMode('secret-input');
                        return;
                    }
                    sendMessage(msg);
                },
            };
            await executeCommand(input, ctx);
            return;
        }

        // Queue if busy, otherwise send immediately
        if (isBusy) {
            queueMessage(input);
        } else {
            // Check if API key is required and missing
            const provider = getCurrentProvider();
            if (provider.requiresKey && !hasApiKey(provider.id)) {
                addOutput('system', `⚠️ API key required for ${provider.name}. Use /keys add ${provider.id}`, colors.yellow);
                // Store the pending message to dispatch after API key is set
                setSecretInputState({ providerId: provider.id, providerName: provider.name, pendingMessage: input });
                setOverlayMode('secret-input');
                return;
            }
            sendMessage(input);
        }
    }, [addOutput, clearHistory, sendMessage, isBusy, queueMessage]);

    // Handle overlay close
    const handleOverlayClose = useCallback(() => {
        setOverlayMode('none');
        setSecretInputState(null);
    }, []);

    // Handle model selection
    const handleModelSelected = useCallback((_modelId: string) => {
        setConfigSummary(getConfigSummary());
    }, []);

    // Handle provider selection
    const handleProviderSelected = useCallback((_providerId: string) => {
        setConfigSummary(getConfigSummary());
        addOutput('system', `🔄 Switched to ${getCurrentProvider().name}`, colors.cyan);
    }, [addOutput]);

    // Handle secret input
    const handleSecretSubmit = useCallback((value: string) => {
        if (secretInputState) {
            setApiKey(secretInputState.providerId, value);
            addOutput('system', `🔑 API key set for ${secretInputState.providerName}`, colors.green);

            // If there was a pending message, dispatch it now
            if (secretInputState.pendingMessage) {
                addOutput('system', `▶️ Sending: ${secretInputState.pendingMessage.substring(0, 50)}${secretInputState.pendingMessage.length > 50 ? '...' : ''}`, colors.dim);
                // Use setTimeout to ensure state updates have propagated
                const pendingMsg = secretInputState.pendingMessage;
                setTimeout(() => sendMessage(pendingMsg), 0);
            }
        }
        setOverlayMode('none');
        setSecretInputState(null);
    }, [secretInputState, addOutput, sendMessage]);

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
                    <span style={{ fontSize: '12px', color: '#8b949e' }}>
                        {configSummary.provider.aliases[0]}:{configSummary.model?.aliases[0] || 'default'}
                        {configSummary.hasKey ? ' 🔑' : configSummary.provider.requiresKey ? ' ⚠️' : ''}
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
                                        overlayMode={overlayMode}
                                        secretInputState={secretInputState}
                                        onSubmit={handleSubmit}
                                        getCompletions={getCommandCompletions}
                                        onCancel={cancelRequest}
                                        onOverlayClose={handleOverlayClose}
                                        onModelSelected={handleModelSelected}
                                        onProviderSelected={handleProviderSelected}
                                        onSecretSubmit={handleSecretSubmit}
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
