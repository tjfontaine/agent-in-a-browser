/**
 * Vercel AI SDK Integration with WASM MCP Server
 * 
 * Uses the Vercel AI SDK for agent orchestration with:
 * - Routes all MCP calls through sandbox worker (single WASM instance)
 * - Anthropic provider with configurable baseURL
 * - Multi-step tool calling with max steps limit
 */

import { generateText, streamText, tool, dynamicTool, stepCountIs, jsonSchema, type CoreMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { fetchFromSandbox } from './agent/sandbox';
import type { McpTool } from './mcp-client';
import { getRemoteMCPRegistry } from './remote-mcp-registry';

export interface AgentConfig {
    model?: string;
    apiKey?: string;
    baseURL?: string; // Backend proxy URL
    maxSteps?: number;
    systemPrompt?: string;
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

// Cache for MCP tools
let cachedTools: McpTool[] = [];

/**
 * Custom MCP Transport that bridges to our WASM MCP server via workerFetch
 * Uses direct POST requests since WASM MCP server doesn't support SSE
 */
let mcpInitialized = false;

/**
 * Send an MCP JSON-RPC request via POST
 */
async function mcpRequest(method: string, params?: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const id = Date.now();
    const request = {
        jsonrpc: '2.0',
        id,
        method,
        params: params || {}
    };

    console.log('[MCP] Request:', method, params);

    const response = await fetchFromSandbox('/mcp/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });

    console.log('[MCP] Response status:', response.status);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`MCP request failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    console.log('[MCP] Response:', result);
    return result;
}


/**
 * Initialize the WASM MCP server and get tools
 */
export async function initializeWasmMcp(): Promise<McpTool[]> {
    if (mcpInitialized) {
        return cachedTools;
    }

    console.log('[Agent] Initializing WASM MCP server...');

    // MCP handshake
    const initResult = await mcpRequest('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        clientInfo: { name: 'web-agent', version: '0.1.0' }
    });

    if (initResult.error) {
        throw new Error(`MCP initialize failed: ${initResult.error.message}`);
    }

    console.log('[Agent] MCP Server:', initResult.result?.serverInfo);

    // Send initialized notification
    await mcpRequest('initialized', {});

    // List available tools
    const toolsResult = await mcpRequest('tools/list', {});

    if (toolsResult.error) {
        throw new Error(`Failed to list tools: ${toolsResult.error.message}`);
    }

    cachedTools = (toolsResult.result?.tools as Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {}
    }));

    mcpInitialized = true;

    console.log('[Agent] Available tools:', cachedTools.map(t => t.name));

    return cachedTools;
}

/**
 * Call an MCP tool with streaming progress support
 * Used by the dynamic tool executors
 */
async function callMcpToolStreaming(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (data: string) => void
): Promise<string> {
    console.log('[MCP Tool Call] Tool:', name);

    if (!mcpInitialized) {
        throw new Error('MCP not initialized');
    }

    try {
        const response = await mcpRequest('tools/call', { name, arguments: args });

        if (response.error) {
            throw new Error(response.error.message);
        }

        const result = response.result;
        if (!result) {
            return 'No result';
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = (result as any).content as Array<{ type: string; text?: string }> || [];
        const textContent = content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('\n');

        console.log('[MCP Tool Call] Result:', textContent.substring(0, 100) + '...');
        return textContent;
    } catch (error: unknown) {
        console.error('[MCP Tool Call] Error:', error);
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Convert MCP tools to Vercel AI SDK tools
 * Uses Zod schemas to properly parse and validate tool arguments
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createAiSdkTools(mcpTools: McpTool[]): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    for (const mcpTool of mcpTools) {
        const properties = (mcpTool.inputSchema?.properties || {}) as Record<string, unknown>;
        const required = (mcpTool.inputSchema?.required || []) as string[];

        // Build Zod schema from MCP inputSchema properties
        const schemaProps: Record<string, z.ZodTypeAny> = {};

        for (const [key, propSchema] of Object.entries(properties) as [string, { type?: string; description?: string }][]) {
            let zodType: z.ZodTypeAny;

            switch (propSchema.type) {
                case 'string':
                    zodType = z.string();
                    break;
                case 'number':
                    zodType = z.number();
                    break;
                case 'boolean':
                    zodType = z.boolean();
                    break;
                case 'object':
                    zodType = z.record(z.string(), z.any());
                    break;
                case 'array':
                    zodType = z.array(z.any());
                    break;
                default:
                    console.warn(`[Agent] Unknown type "${propSchema.type}" for property "${key}", using z.any()`);
                    zodType = z.any();
            }

            if (propSchema.description) {
                zodType = zodType.describe(propSchema.description);
            }

            if (!required.includes(key)) {
                zodType = zodType.optional();
            }

            schemaProps[key] = zodType;
        }

        const inputSchemaObj = {
            type: 'object' as const,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            properties: properties as any,
            required: required,
        };

        tools[mcpTool.name] = dynamicTool({
            description: mcpTool.description || mcpTool.name,
            inputSchema: jsonSchema(inputSchemaObj),
            execute: async (args: unknown) => {
                const argsObj = args as Record<string, unknown>;
                console.log(`[Agent] Executing tool ${mcpTool.name}`);
                return callMcpToolStreaming(mcpTool.name, argsObj);
            },
        });
    }

    // Add frontend-only task_write tool (no WASM roundtrip needed)
    tools['task_write'] = dynamicTool({
        description: 'Manage task list for tracking multi-step work. Updates the task display shown to the user. Use frequently to plan complex tasks and show progress.',
        inputSchema: jsonSchema({
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    description: 'Array of task objects with id, content, and status',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Unique task identifier' },
                            content: { type: 'string', description: 'Task description' },
                            status: { type: 'string', description: 'pending, in_progress, or completed' },
                        },
                        required: ['content', 'status'],
                    },
                },
            },
            required: ['tasks'],
        }),
        execute: async (args: unknown) => {
            const { tasks } = args as { tasks: Array<{ id?: string; content: string; status: string }> };
            console.log('[Agent] task_write called with', tasks.length, 'tasks');

            // Import dynamically to avoid circular dependency
            const { getTaskManager } = await import('./task-manager');
            getTaskManager().setTasks(tasks.map(t => ({
                id: t.id || crypto.randomUUID(),
                content: t.content,
                status: t.status as 'pending' | 'in_progress' | 'completed',
            })));

            return JSON.stringify({ message: `Task list updated: ${tasks.length} tasks` });
        },
    });

    return tools;
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
    private anthropic: ReturnType<typeof createAnthropic> | null = null;
    private tools: Record<string, ReturnType<typeof tool>> = {};
    private mcpTools: McpTool[] = [];
    private initialized = false;
    private messages: CoreMessage[] = [];

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
        this.tools = createAiSdkTools(this.mcpTools);

        // Subscribe to remote registry changes to auto-refresh tools
        const registry = getRemoteMCPRegistry();
        registry.subscribe(() => this.refreshTools());

        // Merge any already-connected remote tools
        this.mergeRemoteTools();

        // Create Anthropic provider
        // Use same origin if no explicit baseURL - Vite proxy will forward to backend
        const baseURL = this.config.baseURL || window.location.origin;
        const isDirectAnthropicCall = baseURL.includes('anthropic.com');
        console.log('[Agent] Creating Anthropic provider with baseURL:', baseURL,
            isDirectAnthropicCall ? '(direct browser access)' : '(via proxy)');

        this.anthropic = createAnthropic({
            apiKey: this.config.apiKey || 'dummy-key',
            baseURL,
            // Enable direct browser access when calling Anthropic API directly
            // This adds the required CORS header for "bring your own API key" scenarios
            headers: isDirectAnthropicCall ? {
                'anthropic-dangerous-direct-browser-access': 'true',
            } : undefined,
        });

        this.initialized = true;
        console.log('[Agent] Ready with', Object.keys(this.tools).length, 'tools');
    }

    /**
     * Refresh tools (called when remote registry changes)
     */
    refreshTools(): void {
        // Rebuild local tools
        this.tools = createAiSdkTools(this.mcpTools);
        // Merge remote tools
        this.mergeRemoteTools();
        console.log('[Agent] Refreshed tools, now have', Object.keys(this.tools).length, 'tools');
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
     * Run a query with real-time streaming callbacks
     * This is the preferred method for TUI as it provides immediate feedback
     */
    async stream(prompt: string, callbacks: StreamCallbacks): Promise<void> {
        await this.initialize();

        if (!this.anthropic) {
            callbacks.onError?.(new Error('Agent not initialized'));
            return;
        }

        // Add user message to history
        this.messages.push({ role: 'user', content: prompt });

        let stepCount = 0;

        try {
            console.log('[Agent] Starting stream with prompt:', prompt.substring(0, 100));

            const result = streamText({
                model: this.anthropic(this.config.model!),
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

        if (!this.anthropic) {
            yield { type: 'error', error: 'Agent not initialized' };
            return;
        }

        // Add user message to history
        this.messages.push({ role: 'user', content: prompt });

        try {
            const result = await generateText({
                model: this.anthropic(this.config.model!),
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

