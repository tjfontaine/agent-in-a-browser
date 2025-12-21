/**
 * Tests for TUI Components
 * 
 * Uses a mock Terminal to capture output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    drawBox,
    renderDiff,
    renderPlan,
    renderToolOutput,
    renderProgress,
    renderSectionHeader,
    Spinner,
    type DiffHunk,
    type PlanItem,
} from './tui';
import type { Terminal } from '@xterm/xterm';

// Mock terminal that captures output
function createMockTerminal(): Terminal & { output: string } {
    const mock = {
        output: '',
        write(data: string) {
            this.output += data;
        },
    } as Terminal & { output: string };
    return mock;
}

describe('TUI Components', () => {
    let term: Terminal & { output: string };

    beforeEach(() => {
        term = createMockTerminal();
    });

    describe('drawBox', () => {
        it('renders title and content', () => {
            drawBox(term, 'Test Title', ['Line 1', 'Line 2']);
            expect(term.output).toContain('Test Title');
            expect(term.output).toContain('Line 1');
            expect(term.output).toContain('Line 2');
        });
    });

    describe('renderDiff', () => {
        it('renders file path header', () => {
            const hunks: DiffHunk[] = [
                { oldText: 'old line', newText: 'new line' }
            ];
            renderDiff(term, '/path/to/file.ts', hunks);
            expect(term.output).toContain('/path/to/file.ts');
        });

        it('renders old lines with minus prefix', () => {
            const hunks: DiffHunk[] = [
                { oldText: 'removed content', newText: '' }
            ];
            renderDiff(term, 'file.ts', hunks);
            expect(term.output).toContain('- removed content');
        });

        it('renders new lines with plus prefix', () => {
            const hunks: DiffHunk[] = [
                { oldText: '', newText: 'added content' }
            ];
            renderDiff(term, 'file.ts', hunks);
            expect(term.output).toContain('+ added content');
        });
    });

    describe('renderPlan', () => {
        it('renders plan items with status icons', () => {
            const items: PlanItem[] = [
                { text: 'Done task', status: 'done' },
                { text: 'Pending task', status: 'pending' },
                { text: 'Running task', status: 'running' },
                { text: 'Error task', status: 'error' },
            ];
            renderPlan(term, items);
            expect(term.output).toContain('Plan');
            expect(term.output).toContain('✓');
            expect(term.output).toContain('○');
            expect(term.output).toContain('⠋');
            expect(term.output).toContain('✗');
        });

        it('numbers items correctly', () => {
            const items: PlanItem[] = [
                { text: 'First', status: 'done' },
                { text: 'Second', status: 'pending' },
            ];
            renderPlan(term, items);
            expect(term.output).toContain('1. First');
            expect(term.output).toContain('2. Second');
        });
    });

    describe('renderToolOutput', () => {
        it('renders success with checkmark', () => {
            renderToolOutput(term, 'read_file', 'path=/test', 'file contents', true);
            expect(term.output).toContain('✓');
            expect(term.output).toContain('read_file');
        });

        it('renders error with X mark', () => {
            renderToolOutput(term, 'write_file', '', 'permission denied', false);
            expect(term.output).toContain('✗');
            expect(term.output).toContain('write_file');
        });

        it('truncates long args', () => {
            const longArgs = 'x'.repeat(100);
            renderToolOutput(term, 'test', longArgs, '', true);
            expect(term.output).toContain('...');
            expect(term.output.length).toBeLessThan(200);
        });
    });

    describe('renderProgress', () => {
        it('renders progress bar', () => {
            renderProgress(term, 5, 10, 'Loading');
            expect(term.output).toContain('━');
            expect(term.output).toContain('Loading');
        });
    });

    describe('renderSectionHeader', () => {
        it('renders title', () => {
            renderSectionHeader(term, 'Section');
            expect(term.output).toContain('Section');
        });
    });

    describe('Spinner', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('starts with message', () => {
            const spinner = new Spinner(term);
            spinner.start('Loading...');
            expect(term.output).toContain('Loading...');
            spinner.stop();
        });

        it('stops with final message', () => {
            const spinner = new Spinner(term);
            spinner.start('Loading...');
            spinner.stop('Done!');
            expect(term.output).toContain('✓');
            expect(term.output).toContain('Done!');
        });

        it('shows error state', () => {
            const spinner = new Spinner(term);
            spinner.start('Loading...');
            spinner.error('Failed!');
            expect(term.output).toContain('✗');
            expect(term.output).toContain('Failed!');
        });
    });
});
