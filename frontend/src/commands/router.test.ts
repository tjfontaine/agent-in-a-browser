/**
 * Tests for Command Router
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSlashCommand } from './router';
import type { Terminal } from '@xterm/xterm';

// Mock the MCP handler
vi.mock('./mcp', () => ({
    handleMcpCommand: vi.fn(),
}));

// Mock terminal
function createMockTerminal(): Terminal & { output: string; cleared: boolean } {
    return {
        output: '',
        cleared: false,
        write(data: string) {
            this.output += data;
        },
        clear() {
            this.cleared = true;
        },
    } as Terminal & { output: string; cleared: boolean };
}

describe('handleSlashCommand', () => {
    let term: Terminal & { output: string; cleared: boolean };
    let clearHistory: ReturnType<typeof vi.fn>;
    let showPrompt: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        term = createMockTerminal();
        clearHistory = vi.fn();
        showPrompt = vi.fn();
    });

    describe('/clear', () => {
        it('should clear terminal and history', () => {
            handleSlashCommand(term, '/clear', clearHistory, showPrompt);
            expect(term.cleared).toBe(true);
            expect(clearHistory).toHaveBeenCalled();
            expect(showPrompt).toHaveBeenCalled();
        });

        it('should display confirmation message', () => {
            handleSlashCommand(term, '/clear', clearHistory, showPrompt);
            expect(term.output).toContain('Conversation cleared');
        });
    });

    describe('/help', () => {
        it('should display available commands', () => {
            handleSlashCommand(term, '/help', clearHistory, showPrompt);
            expect(term.output).toContain('/clear');
            expect(term.output).toContain('/mcp');
            expect(term.output).toContain('/help');
        });

        it('should display MCP subcommands', () => {
            handleSlashCommand(term, '/help', clearHistory, showPrompt);
            expect(term.output).toContain('add');
            expect(term.output).toContain('remove');
            expect(term.output).toContain('auth');
            expect(term.output).toContain('connect');
            expect(term.output).toContain('disconnect');
        });

        it('should call showPrompt', () => {
            handleSlashCommand(term, '/help', clearHistory, showPrompt);
            expect(showPrompt).toHaveBeenCalled();
        });
    });

    describe('unknown command', () => {
        it('should display error for unknown command', () => {
            handleSlashCommand(term, '/unknown', clearHistory, showPrompt);
            expect(term.output).toContain('Unknown command');
            expect(term.output).toContain('/unknown');
        });

        it('should suggest /help', () => {
            handleSlashCommand(term, '/foo', clearHistory, showPrompt);
            expect(term.output).toContain('/help');
        });

        it('should call showPrompt', () => {
            handleSlashCommand(term, '/xyz', clearHistory, showPrompt);
            expect(showPrompt).toHaveBeenCalled();
        });
    });

    describe('invalid format', () => {
        it('should handle empty slash command', () => {
            handleSlashCommand(term, '/', clearHistory, showPrompt);
            expect(term.output).toContain('Invalid command format');
        });
    });
});
