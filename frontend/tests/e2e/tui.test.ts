/**
 * TUI E2E Tests
 *
 * Tests the Rust TUI running via web-agent-tui WASM in ghostty-web.
 * Uses Playwright to test user interactions with the terminal.
 */

import { test, expect, Page } from '@playwright/test';

// Helper to type into the terminal
async function typeInTerminal(page: Page, text: string): Promise<void> {
    // Focus the terminal canvas and type
    const canvas = page.locator('canvas').first();
    await canvas.focus();
    await page.keyboard.type(text, { delay: 50 });
}

// Helper to press keys
async function pressKey(page: Page, key: string): Promise<void> {
    const canvas = page.locator('canvas').first();
    await canvas.focus();
    await page.keyboard.press(key);
}

// Helper to wait for terminal output containing text
async function waitForTerminalOutput(page: Page, text: string, timeout = 10000): Promise<void> {
    await page.waitForFunction(
        (expectedText) => {
            // Look for text in the document body (terminal renders to DOM)
            return document.body.innerText.includes(expectedText);
        },
        text,
        { timeout }
    );
}

test.describe('TUI Launch and Fundamentals', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        // Wait for the terminal to be ready (canvas should be present)
        await page.waitForSelector('canvas', { timeout: 30000 });
        // Wait for welcome message
        await waitForTerminalOutput(page, 'Welcome to Agent in a Browser');
    });

    test('shows welcome message on launch', async ({ page }) => {
        // Welcome message should be visible
        await waitForTerminalOutput(page, 'Welcome to Agent in a Browser');
        await waitForTerminalOutput(page, '/help');
    });

    test('/help shows available commands', async ({ page }) => {
        await typeInTerminal(page, '/help');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Commands:');
        await waitForTerminalOutput(page, '/tools');
        await waitForTerminalOutput(page, '/model');
        await waitForTerminalOutput(page, '/theme');
    });

    test('/config shows configuration', async ({ page }) => {
        await typeInTerminal(page, '/config');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Configuration:');
        await waitForTerminalOutput(page, 'Provider:');
        await waitForTerminalOutput(page, 'Model:');
    });

    test('/theme shows current theme', async ({ page }) => {
        await typeInTerminal(page, '/theme');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Current theme:');
        await waitForTerminalOutput(page, 'Available:');
    });

    test('/clear clears messages', async ({ page }) => {
        // First send a message
        await typeInTerminal(page, '/help');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'Commands:');

        // Now clear
        await typeInTerminal(page, '/clear');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'Messages cleared');
    });
});

test.describe('TUI Tab Completion', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForSelector('canvas', { timeout: 30000 });
        await waitForTerminalOutput(page, 'Welcome');
    });

    test('Tab completes /he to /help', async ({ page }) => {
        await typeInTerminal(page, '/he');
        await pressKey(page, 'Tab');
        await pressKey(page, 'Enter');

        // Should have completed to /help and executed
        await waitForTerminalOutput(page, 'Commands:');
    });

    test('Tab shows multiple completions for /m', async ({ page }) => {
        await typeInTerminal(page, '/m');
        await pressKey(page, 'Tab');

        // Should show both /mcp and /model as options
        await waitForTerminalOutput(page, 'Completions:');
    });
});

test.describe('TUI Model Selector Overlay', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForSelector('canvas', { timeout: 30000 });
        await waitForTerminalOutput(page, 'Welcome');
    });

    test('/model opens model selector overlay', async ({ page }) => {
        await typeInTerminal(page, '/model');
        await pressKey(page, 'Enter');

        // Model selector should show available models
        await waitForTerminalOutput(page, 'Select Model');
        await waitForTerminalOutput(page, 'Claude');
    });

    test('Escape closes model overlay', async ({ page }) => {
        await typeInTerminal(page, '/model');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'Select Model');

        // Press Escape to close
        await pressKey(page, 'Escape');

        // Overlay should be gone, can type again
        await typeInTerminal(page, '/help');
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'Commands:');
    });
});

test.describe('TUI API Key Flow', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForSelector('canvas', { timeout: 30000 });
        await waitForTerminalOutput(page, 'Welcome');
    });

    test('/key triggers API key entry mode', async ({ page }) => {
        await typeInTerminal(page, '/key');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Enter API key');
    });
});

test.describe('TUI Theme Switching', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForSelector('canvas', { timeout: 30000 });
        await waitForTerminalOutput(page, 'Welcome');
    });

    test('/theme dark switches to dark theme', async ({ page }) => {
        await typeInTerminal(page, '/theme dark');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Theme changed to: dark');
    });

    test('/theme light switches to light theme', async ({ page }) => {
        await typeInTerminal(page, '/theme light');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Theme changed to: light');
    });

    test('/theme invalid shows error', async ({ page }) => {
        await typeInTerminal(page, '/theme invalid');
        await pressKey(page, 'Enter');

        await waitForTerminalOutput(page, 'Unknown theme:');
    });
});
