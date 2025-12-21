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
        expect(SYSTEM_PROMPT).toContain('run_typescript');
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

    it('should mention markdown formatting', () => {
        expect(SYSTEM_PROMPT).toContain('markdown');
    });

    it('should mention shell pipes and chaining', () => {
        expect(SYSTEM_PROMPT).toContain('|');
        expect(SYSTEM_PROMPT).toContain('&&');
    });
});
