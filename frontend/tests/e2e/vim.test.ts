/**
 * Vim Editor E2E Tests
 *
 * Tests the vim/vi/edit commands in shell mode via /sh.
 * Uses Playwright to test user interactions with the editor.
 */

import { test, expect, Page } from '@playwright/test';

// Helper to type into the terminal
async function typeInTerminal(page: Page, text: string): Promise<void> {
    await page.evaluate(() => {
        // @ts-expect-error - window.tuiTerminal is set up by main-tui.ts
        window.tuiTerminal?.focus();
    });
    await page.keyboard.type(text, { delay: 50 });
}

// Helper to press keys
async function pressKey(page: Page, key: string): Promise<void> {
    await page.evaluate(() => {
        // @ts-expect-error - window.tuiTerminal is set up by main-tui.ts
        window.tuiTerminal?.focus();
    });
    await page.keyboard.press(key);
}

// Helper to get all terminal screen text via ghostty-web buffer API
async function getTerminalText(page: Page): Promise<string> {
    return await page.evaluate(() => {
        // @ts-expect-error - window.tuiTerminal is set up by main-tui.ts
        const terminal = window.tuiTerminal;
        if (!terminal || !terminal.buffer?.active) {
            return '';
        }

        const lines: string[] = [];
        const buffer = terminal.buffer.active;
        for (let y = 0; y < terminal.rows; y++) {
            const line = buffer.getLine(y);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }
        return lines.join('\n');
    });
}

// Helper to wait for terminal output containing text
async function waitForTerminalOutput(page: Page, text: string, timeout = 5000): Promise<void> {
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

// Helper to wait for TUI to be ready
async function waitForTuiReady(page: Page, timeout = 5000): Promise<void> {
    await page.waitForSelector('canvas', { timeout });
    await page.waitForFunction(
        () => {
            // @ts-expect-error - window.tuiTerminal is set up by main-tui.ts
            return window.tuiTerminal?.buffer?.active !== undefined;
        },
        { timeout }
    );
    await page.waitForTimeout(500);
}

// Helper to enter shell mode and wait for prompt
async function enterShellMode(page: Page): Promise<void> {
    await waitForTerminalOutput(page, '›');
    await typeInTerminal(page, '/sh');
    await pressKey(page, 'Enter');
    // Wait for shell prompt ($ or similar)
    await waitForTerminalOutput(page, '$', 5000);
}

// Helper to exit vim with :q!
async function forceExitVim(page: Page): Promise<void> {
    await pressKey(page, 'Escape');
    await page.waitForTimeout(100);
    await typeInTerminal(page, ':q!');
    await pressKey(page, 'Enter');
    await page.waitForTimeout(500);
}

test.describe('Vim Editor in Shell Mode', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);
    });

    test('vim launches and shows NORMAL mode', async ({ page }) => {
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');

        // Should show NORMAL mode indicator
        await waitForTerminalOutput(page, 'NORMAL', 5000);

        // Exit vim
        await forceExitVim(page);
    });

    test('vi alias launches editor', async ({ page }) => {
        await typeInTerminal(page, 'vi');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'NORMAL', 5000);
        await forceExitVim(page);
    });

    test('edit alias launches editor', async ({ page }) => {
        await typeInTerminal(page, 'edit');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'NORMAL', 5000);
        await forceExitVim(page);
    });

    test('vim with filename shows filename in status', async ({ page }) => {
        await typeInTerminal(page, 'vim test.txt');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'test.txt', 5000);
        await forceExitVim(page);
    });
});

test.describe('Vim Mode Transitions', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);
    });

    test.afterEach(async ({ page }) => {
        await forceExitVim(page);
    });

    test('i enters INSERT mode', async ({ page }) => {
        await pressKey(page, 'i');
        await waitForTerminalOutput(page, 'INSERT');
    });

    test('Escape returns to NORMAL mode', async ({ page }) => {
        await pressKey(page, 'i');
        await waitForTerminalOutput(page, 'INSERT');

        await pressKey(page, 'Escape');
        await waitForTerminalOutput(page, 'NORMAL');
    });

    test('v enters VISUAL mode', async ({ page }) => {
        await pressKey(page, 'v');
        await waitForTerminalOutput(page, 'VISUAL');
    });

    test('V enters V-LINE mode', async ({ page }) => {
        await pressKey(page, 'V');
        await waitForTerminalOutput(page, 'V-LINE');
    });

    test(': enters COMMAND mode', async ({ page }) => {
        await typeInTerminal(page, ':');
        await waitForTerminalOutput(page, 'COMMAND');
    });
});

test.describe('Vim Text Editing', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);
    });

    test.afterEach(async ({ page }) => {
        await forceExitVim(page);
    });

    test('can insert text', async ({ page }) => {
        await pressKey(page, 'i');
        await waitForTerminalOutput(page, 'INSERT');

        await typeInTerminal(page, 'Hello World');
        await waitForTerminalOutput(page, 'Hello World');
    });

    test('A appends at end of line', async ({ page }) => {
        await pressKey(page, 'i');
        await typeInTerminal(page, 'Hello');
        await pressKey(page, 'Escape');

        await pressKey(page, 'A');
        await waitForTerminalOutput(page, 'INSERT');
    });

    test('o opens line below', async ({ page }) => {
        await pressKey(page, 'i');
        await typeInTerminal(page, 'First line');
        await pressKey(page, 'Escape');

        await pressKey(page, 'o');
        await waitForTerminalOutput(page, 'INSERT');
    });
});

test.describe('Vim Undo/Redo', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);
    });

    test.afterEach(async ({ page }) => {
        await forceExitVim(page);
    });

    test('u shows undo message', async ({ page }) => {
        // First make a change
        await pressKey(page, 'i');
        await typeInTerminal(page, 'test');
        await pressKey(page, 'Escape');

        // Undo
        await pressKey(page, 'u');
        const text = await getTerminalText(page);
        // Should show undo message or empty buffer
        expect(text.toLowerCase()).toMatch(/undo|oldest/i);
    });
});

test.describe('Vim File Operations', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);
    });

    test(':q quits editor', async ({ page }) => {
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);

        await typeInTerminal(page, ':q');
        await pressKey(page, 'Enter');

        // Should return to shell prompt
        await waitForTerminalOutput(page, '$', 5000);
    });

    test(':q! force quits modified file', async ({ page }) => {
        await typeInTerminal(page, 'vim');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);

        // Make a change
        await pressKey(page, 'i');
        await typeInTerminal(page, 'text');
        await pressKey(page, 'Escape');

        // Force quit
        await typeInTerminal(page, ':q!');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, '$', 5000);
    });

    test(':w saves file and :wq saves and quits', async ({ page }) => {
        await typeInTerminal(page, 'vim e2e_test_file.txt');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);

        // Insert text
        await pressKey(page, 'i');
        await typeInTerminal(page, 'E2E test content');
        await pressKey(page, 'Escape');

        // Save and quit
        await typeInTerminal(page, ':wq');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, '$', 5000);

        // Verify file exists
        await typeInTerminal(page, 'cat e2e_test_file.txt');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'E2E test content');

        // Cleanup
        await typeInTerminal(page, 'rm e2e_test_file.txt');
        await pressKey(page, 'Enter');
    });
});
