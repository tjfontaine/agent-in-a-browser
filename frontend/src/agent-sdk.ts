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
import { experimental_createMCPClient as createMCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { z } from 'zod';
import { sendMcpRequest } from './agent/sandbox';
import type { JsonRpcRequest, JsonRpcResponse, McpTool } from './mcp-client';
import { getRemoteMCPRegistry } from './remote-mcp-registry';

/**
 * Wrapper that matches the callMcpServer signature for sendMcpRequest
 */
async function callMcpServer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await sendMcpRequest({
        jsonrpc: '2.0',
        id: typeof request.id === 'number' ? request.id : Date.now(),
        method: request.method,
        params: request.params
    });
    return response as JsonRpcResponse;
}

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
    onStepStart?: (step: number) => void;
    onStepFinish?: (step: number) => void;
    onError?: (error: Error) => void;
    onFinish?: (steps: number) => void;
}

// Cache for MCP tools
let cachedTools: McpTool[] = [];

/**
 * Custom MCP Transport that bridges to our WASM MCP server
 */
class WasmMcpTransport implements MCPTransport {
    private messageId = 0;
    private initialized = false;

    async start(): Promise<void> {
        console.log('[WasmTransport] Starting...');

        // Initialize MCP connection
        const initResponse = await callMcpServer({
            jsonrpc: '2.0',
            id: ++this.messageId,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'vercel-ai-sdk', version: '0.1.0' }
            }
        });

        if (initResponse.error) {
            throw new Error(`MCP initialization failed: ${initResponse.error.message}`);
        }

        console.log('[WasmTransport] Server info:', initResponse.result?.serverInfo);

        // Send initialized notification
        await callMcpServer({
            jsonrpc: '2.0',
            id: ++this.messageId,
            method: 'initialized',
            params: {}
        });

        this.initialized = true;
    }

    async close(): Promise<void> {
        console.log('[WasmTransport] Closing...');
        this.initialized = false;
    }

    async send(message: unknown): Promise<void> {
        if (!this.initialized) {
            throw new Error('Transport not initialized');
        }

        const request = message as JsonRpcRequest;
        console.log('[WasmTransport] Sending:', request.method);

        await callMcpServer({
            ...request,
            id: request.id ?? ++this.messageId
        });
    }
}

/**
 * Initialize the WASM MCP server and get tools
 */
export async function initializeWasmMcp(): Promise<McpTool[]> {
    if (cachedTools.length > 0) {
        return cachedTools;
    }

    console.log('[Agent] Initializing WASM MCP server...');

    // Initialize MCP connection
    const initResponse = await callMcpServer({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'vercel-ai-sdk', version: '0.1.0' }
        }
    });

    if (initResponse.error) {
        throw new Error(`MCP initialization failed: ${initResponse.error.message}`);
    }

    console.log('[Agent] MCP server info:', initResponse.result?.serverInfo);

    // Send initialized notification
    await callMcpServer({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialized',
        params: {}
    });

    // List available tools
    const toolsResponse = await callMcpServer({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {}
    });

    if (toolsResponse.error) {
        throw new Error(`Failed to list tools: ${toolsResponse.error.message}`);
    }

    cachedTools = toolsResponse.result?.tools || [];
    console.log('[Agent] Available tools:', cachedTools.map(t => t.name));
    console.log('[Agent] Tool schemas:', JSON.stringify(cachedTools, null, 2));

    return cachedTools;
}

/**
 * Call an MCP tool
 */
async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    console.log('[MCP Tool Call] ===================================');
    console.log('[MCP Tool Call] Tool:', name);
    console.log('[MCP Tool Call] Args:', JSON.stringify(args, null, 2));

    // FAIL LOUDLY: Check for empty or undefined args
    if (!args || Object.keys(args).length === 0) {
        const errorMsg = `INVARIANT VIOLATION: Tool "${name}" called with empty args! This is a bug in the Vercel AI SDK integration.`;
        console.error('[MCP Tool Call] ' + errorMsg);
        console.error('[MCP Tool Call] Cached tools:', cachedTools.map(t => ({ name: t.name, schema: t.inputSchema })));
        throw new Error(errorMsg);
    }

    const response = await callMcpServer({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
            name,
            arguments: args
        }
    });

    console.log('[MCP Tool Call] Response:', JSON.stringify(response, null, 2));

    if (response.error) {
        console.log('[MCP Tool Call] Error:', response.error.message);
        return `Error: ${response.error.message}`;
    }

    // Extract text content from MCP result
    const result = response.result;
    if (result?.content) {
        const output = result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        console.log('[MCP Tool Call] Output:', output);
        return output;
    }

    const stringResult = JSON.stringify(result);
    console.log('[MCP Tool Call] Result (JSON):', stringResult);
    return stringResult;
}

/**
 * Convert MCP tools to Vercel AI SDK tools
 * Uses Zod schemas to properly parse and validate tool arguments
 */
function createAiSdkTools(mcpTools: McpTool[]): Record<string, any> {
    const tools: Record<string, any> = {};

    for (const mcpTool of mcpTools) {
        console.log(`[Agent] Processing tool: ${mcpTool.name}`);
        console.log(`[Agent] Raw inputSchema:`, JSON.stringify(mcpTool.inputSchema, null, 2));

        const properties = mcpTool.inputSchema?.properties || {};
        const required = mcpTool.inputSchema?.required || [];

        console.log(`[Agent] Properties keys:`, Object.keys(properties));
        console.log(`[Agent] Required:`, required);

        // FAIL LOUDLY: Check if properties are empty when they shouldn't be
        if (Object.keys(properties).length === 0) {
            console.error(`[Agent] WARNING: Tool "${mcpTool.name}" has no properties in schema!`);
            console.error(`[Agent] Full inputSchema:`, mcpTool.inputSchema);
        }

        // Build Zod schema from MCP inputSchema properties
        const schemaProps: Record<string, z.ZodTypeAny> = {};

        for (const [key, propSchema] of Object.entries(properties) as [string, any][]) {
            console.log(`[Agent] Processing property "${key}":`, propSchema);
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

        const zodSchema = z.object(schemaProps);

        console.log(`[Agent] Created Zod schema with keys:`, Object.keys(schemaProps));

        // Use dynamicTool for runtime-defined tools with unknown types
        // Must wrap with jsonSchema() to create a valid FlexibleSchema
        const inputSchemaObj = {
            type: 'object' as const,
            properties: properties,
            required: required,
        };

        tools[mcpTool.name] = dynamicTool({
            description: mcpTool.description || mcpTool.name,
            inputSchema: jsonSchema(inputSchemaObj),
            execute: async (args: unknown) => {
                const argsObj = args as Record<string, unknown>;
                console.log(`[Agent] Executing tool ${mcpTool.name}`);
                console.log(`[Agent] Execute received args:`, JSON.stringify(argsObj, null, 2));
                console.log(`[Agent] Args type:`, typeof argsObj);
                console.log(`[Agent] Args keys:`, Object.keys(argsObj || {}));
                return callMcpTool(mcpTool.name, argsObj);
            },
        });
    }

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
        this.anthropic = createAnthropic({
            apiKey: this.config.apiKey || 'dummy-key', // Key handled by proxy
            baseURL: this.config.baseURL,
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
                onStepFinish: async ({ text, toolCalls, toolResults }) => {
                    stepCount++;
                    console.log('[Agent] Step finished:', stepCount);
                    callbacks.onStepFinish?.(stepCount);

                    // Emit tool calls as they complete
                    for (const toolCall of toolCalls || []) {
                        const input = (toolCall as any).input || (toolCall as any).args || {};
                        callbacks.onToolCall?.(toolCall.toolName, input);
                    }

                    // Emit tool results
                    for (const toolResult of toolResults || []) {
                        const output = (toolResult as any).output ?? (toolResult as any).result ?? '';
                        const resultStr = typeof output === 'string' ? output : JSON.stringify(output);
                        // Check if result indicates error
                        const isError = resultStr.startsWith('Error:') || (toolResult as any).isError;
                        callbacks.onToolResult?.(toolResult.toolName, resultStr, !isError);
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

        } catch (error: any) {
            console.error('[Agent] Stream error:', error);
            callbacks.onError?.(error);
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
                onStepFinish: async ({ text, toolCalls, toolResults }) => {
                    console.log('[Agent] Step finished:', {
                        hasText: !!text,
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
                    const input = (toolCall as any).input || (toolCall as any).args;
                    yield {
                        type: 'tool_use',
                        name: toolCall.toolName,
                        input: input as Record<string, unknown>
                    };
                }

                // Dynamic tools use 'output' not 'result'
                for (const toolResult of step.toolResults || []) {
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
        } catch (error: any) {
            console.error('[Agent] Error:', error);
            yield { type: 'error', error: error.message || 'Unknown error' };
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
