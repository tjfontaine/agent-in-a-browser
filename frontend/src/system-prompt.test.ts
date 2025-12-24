/**
 * Tests for System Prompt
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from './system-prompt';

describe('System Prompt', () => {
    it('should be a non-empty string', () => {
        expect(SYSTEM_PROMPT).toBeDefined();
        expect(typeof SYSTEM_PROMPT).toBe('string');
        expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('should mention available tools', () => {
        expect(SYSTEM_PROMPT).toContain('shell_eval');
        expect(SYSTEM_PROMPT).toContain('tsx');
        expect(SYSTEM_PROMPT).toContain('read_file');
        expect(SYSTEM_PROMPT).toContain('write_file');
        expect(SYSTEM_PROMPT).toContain('list');
        expect(SYSTEM_PROMPT).toContain('grep');
    });

    it('should mention OPFS', () => {
        expect(SYSTEM_PROMPT).toContain('OPFS');
    });

    it('should describe tone and style', () => {
        expect(SYSTEM_PROMPT).toContain('Tone and Style');
        expect(SYSTEM_PROMPT).toContain('concise');
    });

    it('should mention text formatting', () => {
        expect(SYSTEM_PROMPT).toContain('Plain text only');
        expect(SYSTEM_PROMPT).toContain('ASCII formatting');
    });

    it('should mention shell pipes and chaining', () => {
        expect(SYSTEM_PROMPT).toContain('Pipes');
        expect(SYSTEM_PROMPT).toContain('Chain operators');
    });

    it('should document task_write tool', () => {
        expect(SYSTEM_PROMPT).toContain('task_write');
        expect(SYSTEM_PROMPT).toContain('pending');
        expect(SYSTEM_PROMPT).toContain('in_progress');
        expect(SYSTEM_PROMPT).toContain('completed');
    });

    it('should include task management guidance', () => {
        expect(SYSTEM_PROMPT).toContain('Task Management');
        expect(SYSTEM_PROMPT).toContain('When to Use task_write');
    });

    it('should include coding guidelines', () => {
        expect(SYSTEM_PROMPT).toContain('Coding Guidelines');
        expect(SYSTEM_PROMPT).toContain('over-engineering');
    });

    it('should include professional tone', () => {
        expect(SYSTEM_PROMPT).toContain('direct and professional');
        expect(SYSTEM_PROMPT).toContain('technical accuracy');
    });

    it('should include parallel tool guidance', () => {
        expect(SYSTEM_PROMPT).toContain('parallel');
        expect(SYSTEM_PROMPT).toContain('sequentially');
    });
});
