/**
 * Tests for Terminal Welcome Banner
 */
import { describe, it, expect } from 'vitest';
import { showWelcome } from './welcome';
import type { Terminal } from '@xterm/xterm';

// Mock terminal
function createMockTerminal(): Terminal & { output: string } {
    return {
        output: '',
        write(data: string) {
            this.output += data;
        },
    } as Terminal & { output: string };
}

describe('showWelcome', () => {
    it('should display Web Agent title', () => {
        const term = createMockTerminal();
        showWelcome(term);
        expect(term.output).toContain('Web Agent');
    });

    it('should display box border characters', () => {
        const term = createMockTerminal();
        showWelcome(term);
        expect(term.output).toContain('╭');
        expect(term.output).toContain('╰');
        expect(term.output).toContain('─');
        expect(term.output).toContain('│');
    });

    it('should mention OPFS', () => {
        const term = createMockTerminal();
        showWelcome(term);
        expect(term.output).toContain('OPFS');
    });

    it('should mention /help command', () => {
        const term = createMockTerminal();
        showWelcome(term);
        expect(term.output).toContain('/help');
    });

    it('should show initializing message', () => {
        const term = createMockTerminal();
        showWelcome(term);
        expect(term.output).toContain('Initializing');
    });

    it('should use ANSI color codes', () => {
        const term = createMockTerminal();
        showWelcome(term);
        // Check for cyan and reset codes
        expect(term.output).toContain('\x1b[36m');
        expect(term.output).toContain('\x1b[0m');
    });
});
