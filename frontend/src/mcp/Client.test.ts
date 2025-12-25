/**
 * Tests for MCP Protocol Types
 */
import { describe, it, expect } from 'vitest';
import type {
    McpServerInfo,
    McpTool,
    McpToolResult,
    JsonRpcRequest,
    JsonRpcResponse
} from './Client';

describe('MCP Types', () => {
    describe('McpServerInfo', () => {
        it('should have correct structure', () => {
            const info: McpServerInfo = {
                name: 'test-server',
                version: '1.0.0',
            };
            expect(info.name).toBe('test-server');
            expect(info.version).toBe('1.0.0');
        });
    });

    describe('McpTool', () => {
        it('should have correct structure', () => {
            const tool: McpTool = {
                name: 'read_file',
                description: 'Read a file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' }
                    },
                    required: ['path']
                },
            };
            expect(tool.name).toBe('read_file');
            const properties = tool.inputSchema.properties as Record<string, { type: string }>;
            expect(properties.path.type).toBe('string');
        });
    });

    describe('McpToolResult', () => {
        it('should represent success', () => {
            const result: McpToolResult = {
                content: [{ type: 'text', text: 'Hello' }],
            };
            expect(result.content[0].text).toBe('Hello');
            expect(result.isError).toBeUndefined();
        });

        it('should represent error', () => {
            const result: McpToolResult = {
                content: [{ type: 'text', text: 'Error: not found' }],
                isError: true,
            };
            expect(result.isError).toBe(true);
        });
    });

    describe('JsonRpcRequest', () => {
        it('should have correct structure for method call', () => {
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            };
            expect(request.jsonrpc).toBe('2.0');
            expect(request.id).toBe(1);
            expect(request.method).toBe('tools/list');
        });

        it('should support string IDs', () => {
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id: 'abc-123',
                method: 'tools/call',
                params: { name: 'read_file', arguments: { path: '/test' } },
            };
            expect(request.id).toBe('abc-123');
            expect(request.params?.name).toBe('read_file');
        });
    });

    describe('JsonRpcResponse', () => {
        it('should represent success response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                id: 1,
                result: { tools: [] },
            };
            expect(response.result).toEqual({ tools: [] });
            expect(response.error).toBeUndefined();
        });

        it('should represent error response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: -32601,
                    message: 'Method not found',
                },
            };
            expect(response.error?.code).toBe(-32601);
            expect(response.result).toBeUndefined();
        });
    });
});
