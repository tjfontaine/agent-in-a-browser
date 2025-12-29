/**
 * useAgent Hook
 * 
 * React hook that provides agent functionality for the ink-web TUI.
 * Bridges the existing agent code with React state management.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { initializeSandbox } from './sandbox';
import { initializeWasmMcp, WasmAgent } from './Sdk';
import { callMcpTool } from './mcp-bridge';
import { setMcpState, isMcpInitialized } from '../commands/mcp';
import { ANTHROPIC_API_KEY } from '../constants';
import { SYSTEM_PROMPT } from './SystemPrompt';
import { AgentMode, PLAN_MODE_SYSTEM_PROMPT, SHELL_EXIT_COMMANDS } from './AgentMode';
import { shellHistory } from './shell-history';
import {
    InteractiveProcessBridge,
} from '../wasm/interactive-process-bridge.js';
import {
    spawnInteractive,
    type ExecEnv,
} from '../wasm/module-loader-impl.js';

// Commands that should launch in interactive mode
// These are TUI applications that need unbuffered I/O
export const INTERACTIVE_COMMANDS = new Set([
    // TUI demos
    'counter', 'ansi-demo', 'tui-demo', 'ratatui-demo',
    // Interactive shell
    'sh', 'shell', 'bash',
]);

import {
    getCurrentModel,
    getCurrentModelInfo,
    getCurrentProvider,
    getApiKey,
    getBackendProxyURL,
    getEffectiveBaseURL,
    subscribeToChanges,
} from '../provider-config';

// Output types for TUI
export interface AgentOutput {
    id: number;
    type: 'text' | 'tool-start' | 'tool-result' | 'error' | 'system' | 'raw';
    content: string;
    color?: string;
    toolName?: string;
    success?: boolean;
}

export interface AgentStatus {
    text: string;
    color: string;
}

export interface UseAgentReturn {
    // State
    status: AgentStatus;
    outputs: AgentOutput[];
    isReady: boolean;
    isBusy: boolean;
    messageQueue: string[];  // Queued messages waiting to be sent
    mode: AgentMode;  // Current agent mode (normal, plan, shell, or interactive)

    // Actions
    initialize: () => Promise<void>;
    sendMessage: (message: string) => Promise<void>;
    queueMessage: (message: string) => void;  // Queue a message while busy
    cancelRequest: () => void;
    clearOutputs: () => void;
    clearHistory: () => void;
    clearQueue: () => void;  // Clear all queued messages
    setMode: (mode: AgentMode) => void;  // Switch agent mode

    // Shell mode
    executeShellDirect: (command: string) => Promise<void>;  // Direct shell execution
    shellHistoryUp: (currentInput?: string) => string | undefined;  // Navigate shell history
    shellHistoryDown: () => string | undefined;  // Navigate shell history
    resetShellHistoryCursor: () => void;  // Reset shell history cursor

    // Interactive mode (TUI applications)
    interactiveBridge: InteractiveProcessBridge | null;  // Bridge for interactive process
    launchInteractive: (moduleName: string, command: string, args?: string[]) => Promise<void>;
    exitInteractive: () => void;
    setRawTerminalWrite: (write: ((text: string) => void) | null) => void;  // Set raw xterm write function

    // Low-level output function for non-agent messages
    addOutput: (type: AgentOutput['type'], content: string, color?: string) => void;
}

// Colors matching our theme
const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    magenta: '#bc8cff',
    dim: '#8b949e',
};

export function useAgent(): UseAgentReturn {
    const [status, setStatus] = useState<AgentStatus>({ text: 'Not initialized', color: colors.dim });
    const [outputs, setOutputs] = useState<AgentOutput[]>([]);
    const [isReady, setIsReady] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [messageQueue, setMessageQueue] = useState<string[]>([]);
    const [mode, setModeState] = useState<AgentMode>('normal');

    const agentRef = useRef<WasmAgent | null>(null);
    const nextIdRef = useRef(0);
    const abortControllerRef = useRef<AbortController | null>(null);
    const cancelRequestedRef = useRef(false);
    const textBufferRef = useRef<string>('');  // Buffer for accumulating streaming text
    const pendingOutputsRef = useRef<AgentOutput[]>([]);  // Pending outputs to batch
    const flushScheduledRef = useRef(false);  // Whether a flush is scheduled

    // Interactive mode state
    const [interactiveBridge, setInteractiveBridge] = useState<InteractiveProcessBridge | null>(null);

    // Raw xterm write function for interactive mode (set by RawXtermTerminal component)
    const rawTerminalWriteRef = useRef<((text: string) => void) | null>(null);

    // Flush pending outputs - batches multiple addOutput calls into single state update
    // This helps mitigate xterm.js issue #5011 by reducing re-render frequency
    // https://github.com/xtermjs/xterm.js/issues/5011
    const flushOutputs = useCallback(() => {
        flushScheduledRef.current = false;
        const pending = pendingOutputsRef.current;
        if (pending.length > 0) {
            pendingOutputsRef.current = [];
            setOutputs(prev => {
                // For raw outputs, try to merge with the last output if it's also raw
                if (pending.length > 0 && pending[0].type === 'raw' &&
                    prev.length > 0 && prev[prev.length - 1].type === 'raw') {
                    // Merge first pending raw output with last existing raw output
                    const merged = {
                        ...prev[prev.length - 1],
                        content: prev[prev.length - 1].content + pending[0].content,
                    };
                    return [...prev.slice(0, -1), merged, ...pending.slice(1)];
                }
                return [...prev, ...pending];
            });
        }
    }, []);

    // Add output helper - batches updates using requestAnimationFrame
    const addOutput = useCallback((
        type: AgentOutput['type'],
        content: string,
        color?: string,
        toolName?: string,
        success?: boolean
    ) => {
        // For 'raw' type, append to the last output if possible (for interactive ANSI output)
        if (type === 'raw') {
            // Try to append to the last pending output or last output
            const pending = pendingOutputsRef.current;
            if (pending.length > 0 && pending[pending.length - 1].type === 'raw') {
                pending[pending.length - 1].content += content;
            } else {
                pending.push({
                    id: nextIdRef.current++,
                    type: 'raw',
                    content,
                    color,
                });
            }
        } else {
            pendingOutputsRef.current.push({
                id: nextIdRef.current++,
                type,
                content,
                color,
                toolName,
                success,
            });
        }

        // Schedule flush on next animation frame if not already scheduled
        if (!flushScheduledRef.current) {
            flushScheduledRef.current = true;
            requestAnimationFrame(flushOutputs);
        }
    }, [flushOutputs]);

    // Initialize sandbox and agent
    const initialize = useCallback(async () => {
        try {
            setStatus({ text: 'Initializing...', color: colors.yellow });
            addOutput('system', 'Initializing sandbox...', colors.dim);

            // Initialize sandbox worker
            await initializeSandbox();
            addOutput('system', '✓ Sandbox ready', colors.green);

            // Initialize MCP
            const tools = await initializeWasmMcp();
            const serverInfo = { name: 'wasm-mcp-server', version: '0.1.0' };
            setMcpState(true, serverInfo, tools);
            addOutput('system', `✓ MCP Server ready: ${serverInfo.name} v${serverInfo.version}`, colors.green);
            addOutput('system', `  ${tools.length} tools available`, colors.dim);

            // Initialize agent with current model and provider
            const provider = getCurrentProvider();
            const modelId = getCurrentModel();
            const modelInfo = getCurrentModelInfo();
            const apiKey = getApiKey(provider.id) || ANTHROPIC_API_KEY;
            // Priority: user override > provider default URL > backend proxy (if enabled)
            // Direct API calls are the default - proxy is opt-in
            const effectiveUrl = getEffectiveBaseURL(provider.id);
            const proxyUrl = getBackendProxyURL();
            const baseURL = effectiveUrl || proxyUrl || '';
            console.log('[useAgent] URL resolution:', { effectiveUrl, proxyUrl, final: baseURL });

            agentRef.current = new WasmAgent({
                model: modelId,
                baseURL,
                apiKey,
                systemPrompt: SYSTEM_PROMPT,
                maxSteps: 15,
                providerType: provider.type,
            });
            addOutput('system', `  Provider: ${provider.name}`, colors.dim);
            addOutput('system', `  Model: ${modelInfo?.name || modelId}`, colors.dim);
            addOutput('system', '✓ Agent ready', colors.green);
            addOutput('system', '', undefined);

            setStatus({ text: 'Ready', color: colors.green });
            setIsReady(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus({ text: 'Error', color: colors.red });
            addOutput('error', `Error: ${message}`, colors.red);
        }
    }, [addOutput]);

    // Send message to agent
    const sendMessage = useCallback(async (message: string) => {
        if (!agentRef.current || !isMcpInitialized()) {
            addOutput('error', 'Agent not initialized. Please wait for initialization.', colors.red);
            return;
        }

        if (isBusy) {
            addOutput('error', 'Agent is busy. Please wait or cancel.', colors.red);
            return;
        }

        setIsBusy(true);
        cancelRequestedRef.current = false;
        abortControllerRef.current = new AbortController();

        // Echo user input
        addOutput('text', `❯ ${message}`, colors.cyan);
        setStatus({ text: 'Thinking...', color: colors.yellow });

        // Reset text buffer
        textBufferRef.current = '';

        try {
            await agentRef.current.stream(message, {
                onText: (text) => {
                    // Accumulate text in buffer
                    textBufferRef.current += text;

                    // Output complete lines only
                    const lines = textBufferRef.current.split('\n');
                    // Keep the last incomplete line in the buffer
                    textBufferRef.current = lines.pop() || '';

                    // Output all complete lines
                    for (const line of lines) {
                        addOutput('text', line);
                    }
                },
                onToolCall: (name, input) => {
                    // Flush any buffered text before tool output
                    if (textBufferRef.current) {
                        addOutput('text', textBufferRef.current);
                        textBufferRef.current = '';
                    }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const args = (input as any).path || (input as any).command || (input as any).code || '';
                    const argsDisplay = typeof args === 'string'
                        ? (args.length > 30 ? args.substring(0, 27) + '...' : args)
                        : '';
                    addOutput('tool-start', `⏳ ${name} ${argsDisplay}`, colors.magenta, name);
                    setStatus({ text: `Running ${name}...`, color: colors.magenta });

                    // Track shell_eval commands in shell history (from agent)
                    if (name === 'shell_eval') {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const command = (input as any).command;
                        if (typeof command === 'string') {
                            shellHistory.add(command, 'agent');
                        }
                    }
                },
                onToolResult: (name, result, success) => {
                    const preview = typeof result === 'string'
                        ? (result.length > 100 ? result.substring(0, 97) + '...' : result)
                        : JSON.stringify(result).substring(0, 100);
                    addOutput(
                        'tool-result',
                        `${success ? '✓' : '✗'} ${name}: ${preview}`,
                        success ? colors.green : colors.red,
                        name,
                        success
                    );
                    setStatus({ text: 'Thinking...', color: colors.yellow });
                },
                onError: (error) => {
                    if (!cancelRequestedRef.current && error.name !== 'AbortError') {
                        addOutput('error', `Error: ${error.message}`, colors.red);
                        setStatus({ text: 'Error', color: colors.red });
                    }
                },
                onFinish: () => {
                    // Flush any remaining buffered text
                    if (textBufferRef.current) {
                        addOutput('text', textBufferRef.current);
                        textBufferRef.current = '';
                    }
                },
                // Provide steering messages - called between steps
                getSteering: () => {
                    // Get steering messages (queued user inputs) and clear the queue
                    const steering: string[] = [];
                    setMessageQueue(prev => {
                        steering.push(...prev);
                        return []; // Clear the queue
                    });
                    return steering;
                },
            });

            setStatus({ text: 'Ready', color: colors.green });
        } catch (error) {
            const err = error as { name?: string; message?: string };
            if (err.name !== 'AbortError' && !cancelRequestedRef.current) {
                addOutput('error', `Error: ${err.message || String(error)}`, colors.red);
                setStatus({ text: 'Error', color: colors.red });
            }
        } finally {
            setIsBusy(false);
            abortControllerRef.current = null;
        }
    }, [addOutput, isBusy]);

    // Cancel current request
    const cancelRequest = useCallback(() => {
        if (abortControllerRef.current) {
            cancelRequestedRef.current = true;
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            addOutput('system', 'Cancelled', colors.dim);
            setStatus({ text: 'Ready', color: colors.green });
            setIsBusy(false);
        }
    }, [addOutput]);

    // Clear outputs
    const clearOutputs = useCallback(() => {
        setOutputs([]);
    }, []);

    // Clear agent conversation history
    const clearHistory = useCallback(() => {
        agentRef.current?.clearHistory();
        clearOutputs();
        addOutput('system', 'Conversation cleared.', colors.dim);
    }, [addOutput, clearOutputs]);

    // Queue a message to be sent after current request completes
    const queueMessage = useCallback((message: string) => {
        setMessageQueue(prev => [...prev, message]);
        addOutput('system', `📋 Queued: ${message}`, colors.dim);
    }, [addOutput]);

    // Clear the message queue
    const clearQueue = useCallback(() => {
        setMessageQueue([]);
        addOutput('system', 'Queue cleared.', colors.dim);
    }, [addOutput]);

    // Set agent mode with output message and update system prompt
    const setMode = useCallback((newMode: AgentMode) => {
        setModeState(newMode);

        // Reset shell history cursor when switching modes
        if (newMode === 'shell') {
            shellHistory.resetCursor();
        }

        // Update agent mode and system prompt (only for agent modes)
        if (agentRef.current && newMode !== 'shell') {
            // Set mode on agent (triggers tool rebuild with mode filtering)
            agentRef.current.setMode(newMode);

            if (newMode === 'plan') {
                // Append plan mode prompt to base prompt
                const planPrompt = SYSTEM_PROMPT + '\n\n' + PLAN_MODE_SYSTEM_PROMPT;
                agentRef.current.updateSystemPrompt(planPrompt);
            } else {
                // Restore normal prompt
                agentRef.current.updateSystemPrompt(SYSTEM_PROMPT);
            }
        }

        if (newMode === 'plan') {
            addOutput('system', '📋 Entered PLAN MODE (read-only)', colors.yellow);
            addOutput('system', '   Agent is now in read-only analysis mode', colors.dim);
            addOutput('system', '   Type "go" or "yes" after planning to execute', colors.dim);
        } else if (newMode === 'shell') {
            // Shell mode message is shown by cmd-shell.ts
        } else {
            addOutput('system', '✓ Switched to NORMAL MODE', colors.green);
        }
    }, [addOutput]);

    // Execute shell command directly (no AI processing)
    const executeShellDirect = useCallback(async (command: string) => {
        if (!isMcpInitialized()) {
            addOutput('error', 'Shell not initialized. Please wait for initialization.', colors.red);
            return;
        }

        // Check for exit commands
        const trimmedCommand = command.trim();
        if (SHELL_EXIT_COMMANDS.includes(trimmedCommand.toLowerCase())) {
            setMode('normal');
            addOutput('system', '📤 Exiting shell mode', colors.dim);
            return;
        }

        // Don't execute empty commands
        if (!trimmedCommand) {
            return;
        }

        // Add to shell history (from user)
        shellHistory.add(trimmedCommand, 'user');

        // Echo the command with shell prompt
        addOutput('text', `$ ${trimmedCommand}`, colors.green);
        setStatus({ text: 'Running...', color: colors.green });

        try {
            const result = await callMcpTool('shell_eval', { command: trimmedCommand });

            // Display output line by line
            const lines = result.split('\n');
            for (const line of lines) {
                addOutput('text', line, colors.dim);
            }

            setStatus({ text: 'Shell Ready', color: colors.green });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addOutput('error', `Error: ${message}`, colors.red);
            setStatus({ text: 'Shell Ready', color: colors.green });
        }
    }, [addOutput, setMode]);

    // Shell history navigation
    const shellHistoryUp = useCallback((currentInput?: string): string | undefined => {
        return shellHistory.navigateUp(currentInput);
    }, []);

    const shellHistoryDown = useCallback((): string | undefined => {
        return shellHistory.navigateDown();
    }, []);

    const resetShellHistoryCursor = useCallback(() => {
        shellHistory.resetCursor();
    }, []);

    // Launch an interactive TUI application
    const launchInteractive = useCallback(async (moduleName: string, command: string, _args: string[] = []) => {
        if (!isMcpInitialized()) {
            addOutput('error', 'Sandbox not initialized. Please wait for initialization.', colors.red);
            return;
        }

        if (interactiveBridge) {
            addOutput('error', 'Interactive process already running. Exit first.', colors.red);
            return;
        }

        addOutput('system', `🖥️ Launching ${command}...`, colors.cyan);

        // Clear terminal for a clean slate in interactive mode
        // \x1b[2J = clear screen, \x1b[H = move cursor home
        addOutput('raw', '\x1b[2J\x1b[H');

        // Create the interactive bridge with callbacks
        // Note: We use a local cleanup function to avoid stale closure issues with exitInteractive
        const bridge = new InteractiveProcessBridge({
            onStdout: (data: Uint8Array) => {
                const text = new TextDecoder().decode(data);
                // Use raw xterm write if available (for proper ANSI handling)
                if (rawTerminalWriteRef.current) {
                    rawTerminalWriteRef.current(text);
                } else {
                    addOutput('raw', text);
                }
            },
            onStderr: (data: Uint8Array) => {
                const text = new TextDecoder().decode(data);
                // Use raw xterm write if available (for proper ANSI handling)
                if (rawTerminalWriteRef.current) {
                    rawTerminalWriteRef.current(`\x1b[31m${text}\x1b[0m`);
                } else {
                    addOutput('raw', text, colors.red);
                }
            },
            onExit: (exitCode: number) => {
                addOutput('system', `Process exited with code ${exitCode}`, colors.dim);
                // Clean up directly here to avoid stale closure issues
                bridge.detach();
                setInteractiveBridge(null);
                rawTerminalWriteRef.current = null;
                setModeState('normal');
                setStatus({ text: 'Ready', color: colors.green });
                addOutput('system', '📤 Exited interactive mode', colors.dim);
            },
        });

        setInteractiveBridge(bridge);
        setModeState('interactive');
        setStatus({ text: 'Interactive', color: colors.magenta });

        try {
            // Build exec environment
            const env: ExecEnv = {
                cwd: '/',
                vars: [],
            };

            // Default terminal size (TODO: get from actual terminal)
            const terminalSize = { cols: 80, rows: 24 };

            // Spawn the interactive process
            const process = await spawnInteractive(moduleName, command, _args, env, terminalSize);

            // Attach bridge to process - this starts polling for output
            bridge.attach(process);

            // Execute the process (runs the command)
            process.execute();

            addOutput('system', `[Interactive mode] Press Ctrl+D or 'q' to exit`, colors.dim);
        } catch (err) {
            console.error('[launchInteractive] Failed to spawn process:', err);
            addOutput('error', `Failed to launch ${command}: ${err instanceof Error ? err.message : String(err)}`, colors.red);
            // Clean up on error
            bridge.detach();
            setInteractiveBridge(null);
            setModeState('shell');
            setStatus({ text: 'Shell Ready', color: colors.green });
        }
    }, [addOutput, interactiveBridge]);

    // Exit interactive mode
    const exitInteractive = useCallback(() => {
        if (interactiveBridge) {
            interactiveBridge.detach();
            setInteractiveBridge(null);
        }
        setModeState('shell');  // Return to shell mode after interactive
        setStatus({ text: 'Shell Ready', color: colors.green });
        addOutput('system', '📤 Exited interactive mode', colors.dim);
    }, [interactiveBridge, addOutput]);


    // Process queued messages when agent becomes idle
    useEffect(() => {
        if (!isBusy && messageQueue.length > 0 && isReady) {
            const nextMessage = messageQueue[0];
            setMessageQueue(prev => prev.slice(1));
            sendMessage(nextMessage);
        }
    }, [isBusy, messageQueue, isReady, sendMessage]);

    // Subscribe to config changes and recreate agent when provider/model switches
    useEffect(() => {
        const unsubscribe = subscribeToChanges(() => {
            if (isReady && agentRef.current) {
                const provider = getCurrentProvider();
                const modelId = getCurrentModel();
                const modelInfo = getCurrentModelInfo();
                const apiKey = getApiKey(provider.id) || ANTHROPIC_API_KEY;
                // Priority: user override > provider default URL > backend proxy (if enabled)
                const baseURL = getEffectiveBaseURL(provider.id) || getBackendProxyURL() || '';

                // Recreate agent with new config
                agentRef.current = new WasmAgent({
                    model: modelId,
                    baseURL,
                    apiKey,
                    systemPrompt: SYSTEM_PROMPT,
                    maxSteps: 15,
                    providerType: provider.type,
                });
                addOutput('system', `🔄 Switched to ${provider.name}:${modelInfo?.name || modelId}`, colors.cyan);
            }
        });
        return unsubscribe;
    }, [isReady, addOutput]);

    return {
        status,
        outputs,
        isReady,
        isBusy,
        messageQueue,
        mode,
        initialize,
        sendMessage,
        queueMessage,
        cancelRequest,
        clearOutputs,
        clearHistory,
        clearQueue,
        setMode,
        executeShellDirect,
        shellHistoryUp,
        shellHistoryDown,
        resetShellHistoryCursor,
        interactiveBridge,
        launchInteractive,
        exitInteractive,
        setRawTerminalWrite: (write: ((text: string) => void) | null) => {
            rawTerminalWriteRef.current = write;
        },
        addOutput,
    };
}
