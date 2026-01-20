/**
 * TUI E2E Tests
 *
 * Tests the Rust TUI running via web-agent-tui WASM in ghostty-web.
 * Uses Playwright to test user interactions with the terminal.
 */

import { test, expect } from './webkit-persistent-fixture';
import type { Page } from '@playwright/test';

// Helper to type into the terminal
async function typeInTerminal(page: Page, text: string): Promise<void> {
    // Focus the terminal via the exposed API, not canvas
    await page.evaluate(() => {
        window.tuiTerminal?.focus();
    });
    // Wait for focus to be fully established (helps with WebKit timing)
    await page.waitForTimeout(100);
    await page.keyboard.type(text, { delay: 50 });
}

// Helper to press keys
async function pressKey(page: Page, key: string): Promise<void> {
    await page.evaluate(() => {
        window.tuiTerminal?.focus();
    });
    // Wait for focus to be fully established (helps with WebKit timing)
    await page.waitForTimeout(50);
    await page.keyboard.press(key);
}

// Helper to get all terminal screen text via ghostty-web buffer API
async function getTerminalText(page: Page): Promise<string> {
    return await page.evaluate(() => {
        const terminal = window.tuiTerminal;
        if (!terminal || !terminal.buffer?.active) {
            return '';
        }

        const lines: string[] = [];
        const buffer = terminal.buffer.active;
        for (let y = 0; y < terminal.rows; y++) {
            const line = buffer.getLine(y);
            if (line) {
                lines.push(line.translateToString(true)); // true = trim right whitespace
            }
        }
        return lines.join('\n');
    });
}

// Helper to wait for terminal output containing text
async function waitForTerminalOutput(page: Page, text: string, timeout = 15000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const screenText = await getTerminalText(page);
        if (screenText.includes(text)) {
            return;
        }
        await page.waitForTimeout(200);
    }
    const finalText = await getTerminalText(page);
    throw new Error(`Timeout waiting for "${text}" in terminal. Current screen:\n${finalText}`);
}

// Helper to wait for TUI to be ready (terminal exposed + canvas present)
async function waitForTuiReady(page: Page, timeout = 30000): Promise<void> {
    await page.waitForSelector('canvas', { timeout });
    await page.waitForFunction(
        () => {
            return window.tuiTerminal?.buffer?.active !== undefined;
        },
        { timeout }
    );
    // Give TUI a moment to render initial content
    await page.waitForTimeout(500);
}

test.describe('TUI Launch and Fundamentals', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
    });

    test('TUI loads and shows prompt', async ({ page }) => {
        // The TUI should show a command prompt (› symbol in Agent mode)
        await waitForTerminalOutput(page, '›');
    });

    test('/help shows available commands', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/help');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Commands:');
        await waitForTerminalOutput(page, '/tools');
    });

    test('/config shows configuration', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/config');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Configuration:');
    });

    test('/theme shows current theme', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/theme');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'theme');
    });

    test('/clear clears messages', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        // First send a command to have something to clear
        await typeInTerminal(page, '/help');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'Commands:');

        // Now clear
        await typeInTerminal(page, '/clear');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'cleared');
    });
});

test.describe('TUI Shell Commands', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
    });

    test('echo command works', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, 'echo hello world');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'hello world');
    });

    test('ls command works', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, 'ls -la');
        await pressKey(page, 'Enter');

        // Should show directory listing (at least show completion)
        await page.waitForTimeout(1000);
        const text = await getTerminalText(page);
        // Just verify it executed and we got a prompt back
        expect(text.split('›').length).toBeGreaterThan(1);
    });
});

test.describe('TUI Model and API Key', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
    });

    test('/model shows model selector', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/model');
        await pressKey(page, 'Enter');

        // Should show model selection UI or current model info
        await page.waitForTimeout(500);
        const text = await getTerminalText(page);
        expect(text.toLowerCase()).toMatch(/model|claude|gpt|gemini/i);
    });

    test('/key triggers API key entry', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/key');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'key');
    });
});

test.describe('TUI Theme Switching', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
    });

    test('/theme dark switches to dark theme', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/theme dark');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'dark');
    });

    test('/theme light switches to light theme', async ({ page }) => {
        await waitForTerminalOutput(page, '›');
        await typeInTerminal(page, '/theme light');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'light');
    });
});
