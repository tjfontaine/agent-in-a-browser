/**
 * Default tool definitions returned when the browser sandbox is not connected.
 * These match the tools defined in runtime/src/lib.rs via #[mcp_tool].
 *
 * Served from cache so Claude Code sees available tools even before the browser connects.
 */

import type { ToolDefinition } from './types.js';

export const DEFAULT_TOOLS: ToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file at the given path. Creates parent directories if needed.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
                content: { type: 'string', description: 'The content parameter' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'list',
        description: 'List files and directories at the given path.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
            },
            required: [],
        },
    },
    {
        name: 'grep',
        description: 'Search for a pattern in files under the given path.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The pattern parameter' },
                path: { type: 'string', description: 'The path parameter' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'shell_eval',
        description:
            "Execute shell commands with pipe support. Supports 50+ commands including: echo, ls, cat, grep, sed, awk, jq, curl, sqlite3, tsx, tar, gzip, and more. Example: 'ls /data | head -n 5'",
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command parameter' },
            },
            required: ['command'],
        },
    },
    {
        name: 'edit_file',
        description:
            'Edit a file by replacing old_str with new_str. The old_str must match exactly and uniquely in the file. For multiple edits, call this tool multiple times. Use read_file first to see the current content.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path parameter' },
                old_str: { type: 'string', description: 'The old_str parameter' },
                new_str: { type: 'string', description: 'The new_str parameter' },
            },
            required: ['path', 'old_str', 'new_str'],
        },
    },
];
