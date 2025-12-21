/**
 * Tests for Constants
 */
import { describe, it, expect } from 'vitest';
import { API_URL, ANTHROPIC_API_KEY, PROMPT } from './constants';

describe('Constants', () => {
    describe('API_URL', () => {
        it('should be a valid localhost URL', () => {
            expect(API_URL).toMatch(/^http:\/\/localhost:\d+$/);
        });

        it('should use port 3001', () => {
            expect(API_URL).toBe('http://localhost:3001');
        });
    });

    describe('ANTHROPIC_API_KEY', () => {
        it('should have a default value', () => {
            expect(ANTHROPIC_API_KEY).toBeDefined();
            expect(typeof ANTHROPIC_API_KEY).toBe('string');
        });
    });

    describe('PROMPT', () => {
        it('should contain an arrow character', () => {
            expect(PROMPT).toContain('❯');
        });

        it('should contain ANSI color codes', () => {
            // Check for cyan color code
            expect(PROMPT).toContain('\x1b[36m');
            // Check for reset code
            expect(PROMPT).toContain('\x1b[0m');
        });
    });
});
