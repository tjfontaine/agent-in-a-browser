/**
 * useAgent Hook
 * 
 * React hook that provides agent functionality for the ink-web TUI.
 * Bridges the existing agent code with React state management.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { initializeSandbox } from './sandbox';
import { initializeWasmMcp, WasmAgent } from '../agent-sdk';
import { setMcpState, isMcpInitialized } from '../commands/mcp';
import { API_URL, ANTHROPIC_API_KEY } from '../constants';
import { SYSTEM_PROMPT } from '../system-prompt';
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
    type: 'text' | 'tool-start' | 'tool-result' | 'error' | 'system';
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

    // Actions
    initialize: () => Promise<void>;
    sendMessage: (message: string) => Promise<void>;
    queueMessage: (message: string) => void;  // Queue a message while busy
    cancelRequest: () => void;
    clearOutputs: () => void;
    clearHistory: () => void;
    clearQueue: () => void;  // Clear all queued messages

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

    const agentRef = useRef<WasmAgent | null>(null);
    const nextIdRef = useRef(0);
    const abortControllerRef = useRef<AbortController | null>(null);
    const cancelRequestedRef = useRef(false);
    const textBufferRef = useRef<string>('');  // Buffer for accumulating streaming text
    const pendingOutputsRef = useRef<AgentOutput[]>([]);  // Pending outputs to batch
    const flushScheduledRef = useRef(false);  // Whether a flush is scheduled

    // Flush pending outputs - batches multiple addOutput calls into single state update
    // This helps mitigate xterm.js issue #5011 by reducing re-render frequency
    // https://github.com/xtermjs/xterm.js/issues/5011
    const flushOutputs = useCallback(() => {
        flushScheduledRef.current = false;
        const pending = pendingOutputsRef.current;
        if (pending.length > 0) {
            pendingOutputsRef.current = [];
            setOutputs(prev => [...prev, ...pending]);
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
        pendingOutputsRef.current.push({
            id: nextIdRef.current++,
            type,
            content,
            color,
            toolName,
            success,
        });

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
            // Priority: user override > backend proxy > fallback constant
            // (Direct API calls hit CORS in browser, so prefer proxy)
            const effectiveUrl = getEffectiveBaseURL(provider.id);
            const proxyUrl = getBackendProxyURL();
            const baseURL = effectiveUrl || proxyUrl || API_URL;
            console.log('[useAgent] URL resolution:', { effectiveUrl, proxyUrl, API_URL, final: baseURL });

            agentRef.current = new WasmAgent({
                model: modelId,
                baseURL,
                apiKey,
                systemPrompt: SYSTEM_PROMPT,
                maxSteps: 15,
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
                // Priority: user override > backend proxy > fallback constant
                const baseURL = getEffectiveBaseURL(provider.id) || getBackendProxyURL() || API_URL;

                // Recreate agent with new config
                agentRef.current = new WasmAgent({
                    model: modelId,
                    baseURL,
                    apiKey,
                    systemPrompt: SYSTEM_PROMPT,
                    maxSteps: 15,
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
        initialize,
        sendMessage,
        queueMessage,
        cancelRequest,
        clearOutputs,
        clearHistory,
        clearQueue,
        addOutput,
    };
}
