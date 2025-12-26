/**
 * Tests for /mode command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modeCommand, registerModeCallbacks } from './cmd-mode';
import { colors } from './types';

describe('modeCommand', () => {
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
        expect(modeCommand.name).toBe('mode');
        expect(modeCommand.description).toContain('mode');
        expect(modeCommand.usage).toBe('/mode [normal|plan]');
        expect(modeCommand.aliases).toContain('m');
    });

    it('should have completions', () => {
        expect(modeCommand.completions).toBeDefined();
        const completions = modeCommand.completions!('n', []);
        expect(completions).toContain('/mode normal');
    });

    it('should show current mode when no args provided', async () => {
        let currentMode: 'normal' | 'plan' = 'normal';
        registerModeCallbacks(() => currentMode, (mode) => { currentMode = mode; });

        const ctx = createContext();
        await modeCommand.handler(ctx, [], {});

        expect(mockOutput).toHaveBeenCalledWith(
            'system',
            expect.stringContaining('NORMAL'),
            colors.green
        );
    });

    it('should show plan mode indicator when in plan mode', async () => {
        let currentMode: 'normal' | 'plan' = 'plan';
        registerModeCallbacks(() => currentMode, (mode) => { currentMode = mode; });

        const ctx = createContext();
        await modeCommand.handler(ctx, [], {});

        expect(mockOutput).toHaveBeenCalledWith(
            'system',
            expect.stringContaining('PLAN'),
            colors.yellow
        );
    });

    it('should switch to plan mode', async () => {
        let currentMode: 'normal' | 'plan' = 'normal';
        const setMode = vi.fn((mode: 'normal' | 'plan') => { currentMode = mode; });
        registerModeCallbacks(() => currentMode, setMode);

        const ctx = createContext();
        await modeCommand.handler(ctx, ['plan'], {});

        expect(setMode).toHaveBeenCalledWith('plan');
    });

    it('should switch to normal mode', async () => {
        let currentMode: 'normal' | 'plan' = 'plan';
        const setMode = vi.fn((mode: 'normal' | 'plan') => { currentMode = mode; });
        registerModeCallbacks(() => currentMode, setMode);

        const ctx = createContext();
        await modeCommand.handler(ctx, ['normal'], {});

        expect(setMode).toHaveBeenCalledWith('normal');
    });

    it('should show error for unknown mode', async () => {
        registerModeCallbacks(() => 'normal', () => { });

        const ctx = createContext();
        await modeCommand.handler(ctx, ['invalid'], {});

        expect(mockOutput).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('Unknown mode'),
            colors.red
        );
    });

    it('should show message when already in requested mode', async () => {
        registerModeCallbacks(() => 'normal', () => { });

        const ctx = createContext();
        await modeCommand.handler(ctx, ['normal'], {});

        expect(mockOutput).toHaveBeenCalledWith(
            'system',
            expect.stringContaining('Already in'),
            colors.dim
        );
    });
});
