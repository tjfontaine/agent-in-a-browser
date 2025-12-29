/**
 * Vercel AI SDK Integration with WASM MCP Server
 * 
 * Uses the Vercel AI SDK for agent orchestration with:
 * - Routes all MCP calls through sandbox worker (single WASM instance)
 * - Anthropic provider with configurable baseURL
 * - Multi-step tool calling with max steps limit
 */

import { generateText, streamText, stepCountIs, type CoreMessage, type Tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { McpTool } from '../mcp';
import { getRemoteMCPRegistry } from '../mcp';
import { initializeWasmMcp } from './mcp-bridge';
import { createAllTools } from './tool-converter';
import { AgentMode } from './AgentMode';

// Re-export for backward compatibility
export { initializeWasmMcp } from './mcp-bridge';

export interface AgentConfig {
    model?: string;
    apiKey?: string;
    baseURL?: string; // Backend proxy URL
    maxSteps?: number;
    systemPrompt?: string;
    providerType?: 'anthropic' | 'openai';  // Provider type, defaults to anthropic
}

/**
 * Callbacks for streaming agent execution
 */
export interface StreamCallbacks {
    onText?: (text: string) => void;
    onToolCall?: (name: string, input: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string, success: boolean) => void;
    onToolProgress?: (name: string, data: string) => void;  // Live progress from tool execution
    onStepStart?: (step: number) => void;
    onStepFinish?: (step: number) => void;
    onError?: (error: Error) => void;
    onFinish?: (steps: number) => void;
    /** Called between steps to get any pending steering messages from user */
    getSteering?: () => string[];
}

/**
 * Agent message types for streaming
 */
export type AgentMessage =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; name: string; result: string }
    | { type: 'error'; error: string }
    | { type: 'done'; steps: number };

/**
 * Simple agent class for browser use with streaming support
 */
export class WasmAgent {
    private config: AgentConfig;
    private provider: ReturnType<typeof createAnthropic> | ReturnType<typeof createOpenAI> | null = null;
    private tools: Record<string, Tool<unknown, unknown>> = {};
    private mcpTools: McpTool[] = [];
    private initialized = false;
    private messages: CoreMessage[] = [];
    private mode: AgentMode = 'normal';

    constructor(config: AgentConfig = {}) {
        this.config = {
            model: 'claude-sonnet-4-5',
            maxSteps: 10,
            ...config
        };
    }

    /**
     * Initialize the agent
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        console.log('[Agent] Initializing...');

        // Initialize WASM MCP and get local tools
        this.mcpTools = await initializeWasmMcp();
        this.tools = createAllTools(this.mcpTools, () => this.mode);

        // Subscribe to remote registry changes to auto-refresh tools
        const registry = getRemoteMCPRegistry();
        registry.subscribe(() => this.refreshTools());

        // Merge any already-connected remote tools
        this.mergeRemoteTools();

        // Create provider based on type
        const providerType = this.config.providerType || 'anthropic';
        let baseURL = this.config.baseURL || '';

        if (providerType === 'openai') {
            console.log('[Agent] Creating OpenAI provider:', { baseURL: baseURL || 'default' });
            this.provider = createOpenAI({
                apiKey: this.config.apiKey || 'dummy-key',
                baseURL: baseURL || undefined,
            });
        } else {
            // Anthropic provider
            if (!baseURL) {
                baseURL = window.location.origin;
            }
            const isDirectAnthropicCall = baseURL.includes('anthropic.com');

            // Ensure Anthropic URLs have the /v1 suffix
            if (isDirectAnthropicCall && !baseURL.includes('/v1')) {
                baseURL = baseURL.replace(/\/?$/, '/v1');
            }

            const headers = isDirectAnthropicCall ? {
                'anthropic-dangerous-direct-browser-access': 'true',
            } : undefined;

            console.log('[Agent] Creating Anthropic provider:', {
                baseURL,
                isDirectAnthropicCall,
                headers: headers ? Object.keys(headers) : 'none',
            });

            this.provider = createAnthropic({
                apiKey: this.config.apiKey || 'dummy-key',
                baseURL,
                headers,
            });
        }

        this.initialized = true;
        console.log('[Agent] Ready with', Object.keys(this.tools).length, 'tools');
    }

    /**
     * Refresh tools (called when remote registry changes or mode changes)
     */
    refreshTools(): void {
        // Rebuild local tools with current mode
        this.tools = createAllTools(this.mcpTools, () => this.mode);
        // Merge remote tools
        this.mergeRemoteTools();
        console.log('[Agent] Refreshed tools, now have', Object.keys(this.tools).length, 'tools');
    }

    /**
     * Set the agent mode and refresh tools
     */
    setMode(mode: AgentMode): void {
        if (this.mode !== mode) {
            this.mode = mode;
            if (this.initialized) {
                this.refreshTools();
            }
            console.log('[Agent] Mode set to:', mode);
        }
    }

    /**
     * Get current mode
     */
    getMode(): AgentMode {
        return this.mode;
    }

    /**
     * Merge tools from connected remote MCP servers
     */
    private mergeRemoteTools(): void {
        const registry = getRemoteMCPRegistry();
        const remoteTools = registry.getAggregatedTools();

        // Merge remote tools into our tool set
        for (const [name, tool] of Object.entries(remoteTools)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.tools[name] = tool as any;
        }

        console.log('[Agent] Merged', Object.keys(remoteTools).length, 'remote tools');
    }

    /**
     * Get available tools
     */
    getTools(): McpTool[] {
        return this.mcpTools;
    }

    /**
     * Clear conversation history
     */
    clearHistory(): void {
        this.messages = [];
    }

    /**
     * Get conversation history
     */
    getHistory(): CoreMessage[] {
        return [...this.messages];
    }

    /**
     * Update the system prompt (e.g., when switching modes)
     */
    updateSystemPrompt(prompt: string): void {
        this.config.systemPrompt = prompt;
        console.log('[Agent] System prompt updated');
    }

    /**
     * Get current system prompt
     */
    getSystemPrompt(): string | undefined {
        return this.config.systemPrompt;
    }

    /**
     * Run a query with real-time streaming callbacks
     * This is the preferred method for TUI as it provides immediate feedback
     */
    async stream(prompt: string, callbacks: StreamCallbacks): Promise<void> {
        await this.initialize();

        if (!this.provider) {
            callbacks.onError?.(new Error('Agent not initialized'));
            return;
        }

        // Add user message to history
        this.messages.push({ role: 'user', content: prompt });

        let stepCount = 0;

        try {
            console.log('[Agent] Starting stream with prompt:', prompt.substring(0, 100));

            const result = streamText({
                model: this.provider(this.config.model!),
                tools: this.tools,
                stopWhen: stepCountIs(this.config.maxSteps!),
                system: this.config.systemPrompt,
                messages: this.messages,
                onChunk: ({ chunk }) => {
                    if (chunk.type === 'text-delta') {
                        callbacks.onText?.(chunk.text);
                    }
                },
                onStepFinish: async ({ text: stepText, toolCalls, toolResults }) => {
                    stepCount++;
                    console.log('[Agent] Step finished:', stepCount);
                    callbacks.onStepFinish?.(stepCount);

                    // Add assistant's step text to history if any
                    if (stepText) {
                        this.messages.push({ role: 'assistant', content: stepText });
                    }

                    // Emit tool calls as they complete
                    for (const toolCall of toolCalls || []) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const input = (toolCall as any).input || (toolCall as any).args || {};
                        callbacks.onToolCall?.(toolCall.toolName, input);
                    }

                    // Emit tool results
                    for (const toolResult of toolResults || []) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const output = (toolResult as any).output ?? (toolResult as any).result ?? '';
                        const resultStr = typeof output === 'string' ? output : JSON.stringify(output);
                        // Check if result indicates error
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const isError = resultStr.startsWith('Error:') || (toolResult as any).isError;
                        callbacks.onToolResult?.(toolResult.toolName, resultStr, !isError);
                    }

                    // Check for steering messages from user (typed while agent was working)
                    if (callbacks.getSteering) {
                        const steeringMessages = callbacks.getSteering();
                        if (steeringMessages.length > 0) {
                            // Inject steering as user messages for the agent to see
                            for (const steer of steeringMessages) {
                                console.log('[Agent] Injecting steering:', steer);
                                callbacks.onText?.(`\n\n💡 [User steering]: ${steer}\n\n`);
                                this.messages.push({
                                    role: 'user',
                                    content: `[IMPORTANT - User steering while you were working]: ${steer}`
                                });
                            }
                        }
                    }
                },
                onError: ({ error }) => {
                    // Handle streaming errors (e.g., model not found, auth errors)
                    console.error('[Agent] Stream error event:', error);
                    // Extract message from various error formats
                    let message = 'Unknown error';
                    if (error instanceof Error) {
                        message = error.message;
                    } else if (typeof error === 'object' && error !== null) {
                        // Handle API error format: {type: 'error', error: {message: '...'}}
                        const errorObj = error as Record<string, unknown>;
                        if (typeof errorObj.message === 'string') {
                            message = errorObj.message;
                        } else if (errorObj.error && typeof (errorObj.error as Record<string, unknown>).message === 'string') {
                            message = (errorObj.error as Record<string, unknown>).message as string;
                        }
                    }
                    callbacks.onError?.(new Error(message));
                },
            });

            // Consume the full stream - this drives execution
            const response = await result;

            // Wait for all text to be processed
            const finalText = await response.text;

            // Add assistant response to history
            if (finalText) {
                this.messages.push({ role: 'assistant', content: finalText });
            }

            callbacks.onFinish?.(stepCount);
            console.log('[Agent] Stream complete, steps:', stepCount);

        } catch (error: unknown) {
            console.error('[Agent] Stream error:', error);
            callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Run a query with streaming results (generator-based, for compatibility)
     */
    async *query(prompt: string): AsyncGenerator<AgentMessage, void, unknown> {
        await this.initialize();

        if (!this.provider) {
            yield { type: 'error', error: 'Agent not initialized' };
            return;
        }

        // Add user message to history
        this.messages.push({ role: 'user', content: prompt });

        try {
            const result = await generateText({
                model: this.provider(this.config.model!),
                tools: this.tools,
                stopWhen: stepCountIs(this.config.maxSteps!),
                system: this.config.systemPrompt,
                messages: this.messages,
                onStepFinish: async ({ text: _text, toolCalls, toolResults: _toolResults }) => {
                    console.log('[Agent] Step finished:', {
                        hasText: !!_text,
                        toolCalls: toolCalls?.length || 0
                    });
                },
            });

            // Emit all steps
            for (const step of result.steps) {
                // Emit text if present
                if (step.text) {
                    yield { type: 'text', text: step.text };
                }

                // Emit tool calls and results (dynamic tools use 'input' not 'args')
                for (const toolCall of step.toolCalls || []) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const input = (toolCall as any).input || (toolCall as any).args;
                    yield {
                        type: 'tool_use',
                        name: toolCall.toolName,
                        input: input as Record<string, unknown>
                    };
                }

                // Dynamic tools use 'output' not 'result'
                for (const toolResult of step.toolResults || []) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const output = (toolResult as any).output || (toolResult as any).result;
                    yield {
                        type: 'tool_result',
                        name: toolResult.toolName,
                        result: typeof output === 'string'
                            ? output
                            : JSON.stringify(output)
                    };
                }
            }

            // Final text - add to history
            if (result.text) {
                yield { type: 'text', text: result.text };
                this.messages.push({ role: 'assistant', content: result.text });
            }

            yield { type: 'done', steps: result.steps.length };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[Agent] Error:', error);
            yield { type: 'error', error: message || 'Unknown error' };
        }
    }

    /**
     * Run a query and get all messages (non-streaming)
     */
    async chat(prompt: string): Promise<AgentMessage[]> {
        const messages: AgentMessage[] = [];
        for await (const msg of this.query(prompt)) {
            messages.push(msg);
        }
        return messages;
    }
}

