/**
 * Tests for shell-history.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { shellHistory } from './shell-history';

describe('ShellHistory', () => {
    beforeEach(() => {
        // Clear history before each test
        shellHistory.clear();
    });

    describe('add', () => {
        it('should add commands to history', () => {
            shellHistory.add('ls -la', 'user');
            shellHistory.add('pwd', 'agent');

            const all = shellHistory.getAll();
            expect(all).toHaveLength(2);
            expect(all[0].command).toBe('ls -la');
            expect(all[0].source).toBe('user');
            expect(all[1].command).toBe('pwd');
            expect(all[1].source).toBe('agent');
        });

        it('should not add empty commands', () => {
            shellHistory.add('', 'user');
            shellHistory.add('   ', 'user');

            expect(shellHistory.getAll()).toHaveLength(0);
        });

        it('should not add duplicate of most recent command', () => {
            shellHistory.add('ls', 'user');
            shellHistory.add('ls', 'user');
            shellHistory.add('ls', 'agent'); // Same command, different source - still not added

            expect(shellHistory.getAll()).toHaveLength(1);
        });

        it('should include timestamp', () => {
            const before = Date.now();
            shellHistory.add('test', 'user');
            const after = Date.now();

            const entry = shellHistory.getAll()[0];
            expect(entry.timestamp).toBeGreaterThanOrEqual(before);
            expect(entry.timestamp).toBeLessThanOrEqual(after);
        });
    });

    describe('navigation', () => {
        beforeEach(() => {
            shellHistory.add('first', 'user');
            shellHistory.add('second', 'user');
            shellHistory.add('third', 'agent');
        });

        it('should navigate up through history', () => {
            expect(shellHistory.navigateUp('current')).toBe('third');
            expect(shellHistory.navigateUp()).toBe('second');
            expect(shellHistory.navigateUp()).toBe('first');
            // At beginning, stays at first
            expect(shellHistory.navigateUp()).toBe('first');
        });

        it('should navigate down through history', () => {
            // Go to beginning
            shellHistory.navigateUp('current');
            shellHistory.navigateUp();
            shellHistory.navigateUp();

            expect(shellHistory.navigateDown()).toBe('second');
            expect(shellHistory.navigateDown()).toBe('third');
            // Past end returns pending input
            expect(shellHistory.navigateDown()).toBe('current');
        });

        it('should reset cursor', () => {
            shellHistory.navigateUp('typed');
            shellHistory.navigateUp();
            shellHistory.resetCursor();

            // After reset, navigating up starts from the end again
            expect(shellHistory.navigateUp('new')).toBe('third');
        });

        it('should return undefined for down when not navigating', () => {
            expect(shellHistory.navigateDown()).toBeUndefined();
        });
    });

    describe('getBySource', () => {
        it('should filter by source', () => {
            shellHistory.add('user1', 'user');
            shellHistory.add('agent1', 'agent');
            shellHistory.add('user2', 'user');

            const userCmds = shellHistory.getBySource('user');
            expect(userCmds).toHaveLength(2);
            expect(userCmds[0].command).toBe('user1');
            expect(userCmds[1].command).toBe('user2');

            const agentCmds = shellHistory.getBySource('agent');
            expect(agentCmds).toHaveLength(1);
            expect(agentCmds[0].command).toBe('agent1');
        });
    });

    describe('length', () => {
        it('should return correct length', () => {
            expect(shellHistory.length).toBe(0);
            shellHistory.add('one', 'user');
            expect(shellHistory.length).toBe(1);
            shellHistory.add('two', 'agent');
            expect(shellHistory.length).toBe(2);
        });
    });

    describe('clear', () => {
        it('should clear all entries', () => {
            shellHistory.add('cmd1', 'user');
            shellHistory.add('cmd2', 'agent');
            shellHistory.clear();

            expect(shellHistory.getAll()).toHaveLength(0);
            expect(shellHistory.length).toBe(0);
        });
    });
});
