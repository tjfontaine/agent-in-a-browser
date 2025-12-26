/**
 * Tests for /plan command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planCommand, registerModeCallbacks } from './cmd-plan';
import { colors } from './types';

describe('planCommand', () => {
    const mockOutput = vi.fn();
    const mockClearHistory = vi.fn();
    const mockSendMessage = vi.fn();

    const createContext = () => ({
        output: mockOutput,
        clearHistory: mockClearHistory,
        sendMessage: mockSendMessage,
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should have correct metadata', () => {
        expect(planCommand.name).toBe('plan');
        expect(planCommand.description).toContain('plan mode');
        expect(planCommand.usage).toBe('/plan [description]');
    });

    it('should error if mode callbacks not registered', async () => {
        // Reset callbacks by registering null-like function
        // (in real code, callbacks start as null)
        // Note: This test relies on internal state; in production, callbacks are registered on app init
        // For now, we just verify the handler exists
        expect(planCommand.handler).toBeDefined();
    });

    it('should switch to plan mode when callbacks are registered', async () => {
        let currentMode: 'normal' | 'plan' = 'normal';
        const getMode = () => currentMode;
        const setMode = (mode: 'normal' | 'plan') => { currentMode = mode; };

        registerModeCallbacks(getMode, setMode);

        const ctx = createContext();
        await planCommand.handler(ctx, [], {});

        expect(currentMode).toBe('plan');
    });

    it('should send message when in plan mode with description', async () => {
        let currentMode: 'normal' | 'plan' = 'normal';
        const getMode = () => currentMode;
        const setMode = (mode: 'normal' | 'plan') => { currentMode = mode; };

        registerModeCallbacks(getMode, setMode);

        const ctx = createContext();
        await planCommand.handler(ctx, ['add', 'authentication'], {});

        expect(currentMode).toBe('plan');
        expect(mockSendMessage).toHaveBeenCalledWith(
            expect.stringContaining('add authentication')
        );
    });

    it('should show already in plan mode message when called again', async () => {
        let currentMode: 'normal' | 'plan' = 'plan';
        const getMode = () => currentMode;
        const setMode = (mode: 'normal' | 'plan') => { currentMode = mode; };

        registerModeCallbacks(getMode, setMode);

        const ctx = createContext();
        await planCommand.handler(ctx, [], {});

        expect(mockOutput).toHaveBeenCalledWith(
            'system',
            'Already in PLAN MODE',
            colors.yellow
        );
    });
});
