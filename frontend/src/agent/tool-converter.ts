/**
 * Tool Converter - MCP Tools to Vercel AI SDK Format
 * 
 * Converts MCP tools into Vercel AI SDK dynamic tools with proper
 * JSON Schema handling and Zod validation.
 */

import { dynamicTool, jsonSchema } from 'ai';
import { z } from 'zod';
import type { McpTool } from '../mcp-client';
import { callMcpTool } from './mcp-bridge';

// ============================================================
// SCHEMA CONVERSION
// ============================================================

/**
 * Convert a JSON Schema type to a Zod type.
 * 
 * @param propSchema - The JSON Schema property definition
 * @param key - Property name (for logging)
 * @param isRequired - Whether this property is required
 * @returns Zod type definition
 */
function jsonSchemaToZod(
    propSchema: { type?: string; description?: string },
    key: string,
    isRequired: boolean
): z.ZodTypeAny {
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

    if (!isRequired) {
        zodType = zodType.optional();
    }

    return zodType;
}

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

        // Build Zod schema from MCP inputSchema properties (for future use)
        const schemaProps: Record<string, z.ZodTypeAny> = {};
        for (const [key, propSchema] of Object.entries(properties) as [string, { type?: string; description?: string }][]) {
            schemaProps[key] = jsonSchemaToZod(propSchema, key, required.includes(key));
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
            const { getTaskManager } = await import('../task-manager');
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
