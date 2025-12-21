/**
 * Tests for Shared Types
 */
import { describe, it, expect } from 'vitest';
import type {
    SandboxMessage,
    SandboxRequest,
    ToolCallResult
} from './types';

describe('Types', () => {
    describe('SandboxMessage', () => {
        it('should represent init_complete message', () => {
            const msg: SandboxMessage = {
                type: 'init_complete',
            };
            expect(msg.type).toBe('init_complete');
        });

        it('should represent error message with details', () => {
            const msg: SandboxMessage = {
                type: 'error',
                id: 'req-123',
                message: 'Failed to initialize',
            };
            expect(msg.type).toBe('error');
            expect(msg.message).toBe('Failed to initialize');
        });
    });

    describe('SandboxRequest', () => {
        it('should represent init request', () => {
            const req: SandboxRequest = {
                type: 'init',
            };
            expect(req.type).toBe('init');
        });

        it('should represent fetch request', () => {
            const req: SandboxRequest = {
                type: 'fetch',
                id: 'req-123',
                url: 'https://api.example.com',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"data": "test"}',
            };
            expect(req.type).toBe('fetch');
            expect(req.method).toBe('POST');
            expect(req.headers?.['Content-Type']).toBe('application/json');
        });
    });

    describe('ToolCallResult', () => {
        it('should represent success', () => {
            const result: ToolCallResult = {
                output: 'file contents here',
            };
            expect(result.output).toBe('file contents here');
            expect(result.isError).toBeUndefined();
        });

        it('should represent error', () => {
            const result: ToolCallResult = {
                error: 'File not found',
                isError: true,
            };
            expect(result.error).toBe('File not found');
            expect(result.isError).toBe(true);
        });
    });
});
