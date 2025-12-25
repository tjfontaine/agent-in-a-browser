/**
 * Tool Converter - MCP Tools to Vercel AI SDK Format
 * 
 * Converts MCP tools into Vercel AI SDK dynamic tools.
 * Uses AI SDK's jsonSchema() for JSON Schema validation.
 */

import { dynamicTool, jsonSchema } from 'ai';
import type { McpTool } from '../mcp';
import { callMcpTool } from './mcp-bridge';

// ============================================================
// TOOL CONVERSION
// ============================================================

/**
 * Convert MCP tools to Vercel AI SDK tools.
 * 
 * This creates dynamicTool instances that wrap MCP tool calls with
 * proper schema validation and execution.
 * 
 * @param mcpTools - Array of MCP tool definitions
 * @returns Record of AI SDK tool instances
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAiSdkTools(mcpTools: McpTool[]): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    for (const mcpTool of mcpTools) {
        const properties = (mcpTool.inputSchema?.properties || {}) as Record<string, unknown>;
        const required = (mcpTool.inputSchema?.required || []) as string[];

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
                return callMcpTool(mcpTool.name, argsObj);
            },
        });
    }

    return tools;
}

// ============================================================
// BUILT-IN TOOLS
// ============================================================

/**
 * Create the task_write tool for managing the task display.
 * This is a frontend-only tool that doesn't go through WASM.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTaskWriteTool(): any {
    return dynamicTool({
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
            const { getTaskManager } = await import('./TaskManager');
            getTaskManager().setTasks(tasks.map(t => ({
                id: t.id || crypto.randomUUID(),
                content: t.content,
                status: t.status as 'pending' | 'in_progress' | 'completed',
            })));

            return JSON.stringify({ message: `Task list updated: ${tasks.length} tasks` });
        },
    });
}

/**
 * Create all AI SDK tools from MCP tools plus built-in frontend tools.
 * 
 * @param mcpTools - Array of MCP tool definitions
 * @returns Record of all tool instances
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAllTools(mcpTools: McpTool[]): Record<string, any> {
    const tools = createAiSdkTools(mcpTools);
    tools['task_write'] = createTaskWriteTool();
    return tools;
}
