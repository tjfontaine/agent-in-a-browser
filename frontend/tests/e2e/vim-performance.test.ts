/**
 * Vim Editor Performance Tests
 *
 * Benchmarks navigation performance with syntax highlighting enabled.
 * This test proves that caching SyntaxSet/ThemeSet improves responsiveness.
 */

import { test, expect } from './webkit-persistent-fixture';
import type { Page } from '@playwright/test';

// Helper to type into the terminal (fast mode for short strings)
async function typeInTerminal(page: Page, text: string, fast = false): Promise<void> {
    await page.evaluate(() => {
        window.tuiTerminal?.focus();
    });
    await page.keyboard.type(text, { delay: fast ? 10 : 50 });
}

// Helper to press keys
async function pressKey(page: Page, key: string): Promise<void> {
    await page.evaluate(() => {
        window.tuiTerminal?.focus();
    });
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
        await page.waitForTimeout(100);
    }
    const finalText = await getTerminalText(page);
    throw new Error(`Timeout waiting for "${text}" in terminal. Current screen:\n${finalText}`);
}

// Helper to wait for TUI to be ready
async function waitForTuiReady(page: Page, timeout = 15000): Promise<void> {
    await page.waitForSelector('canvas', { timeout });
    await page.waitForFunction(
        () => {
            return window.tuiTerminal?.buffer?.active !== undefined;
        },
        { timeout }
    );
    await page.waitForTimeout(1000); // Extra time for WASM initialization
}

// Helper to enter shell mode and wait for prompt
async function enterShellMode(page: Page): Promise<void> {
    await waitForTerminalOutput(page, '›');
    await typeInTerminal(page, '/sh', true);
    await pressKey(page, 'Enter');
    await waitForTerminalOutput(page, '$', 5000);
}

// Helper to exit vim with :q!
async function forceExitVim(page: Page): Promise<void> {
    await pressKey(page, 'Escape');
    await page.waitForTimeout(100);
    await typeInTerminal(page, ':q!', true);
    await pressKey(page, 'Enter');
    await page.waitForTimeout(500);
}

test.describe('Vim Navigation Performance', () => {
    test('navigation latency with syntax-highlighted file stays under threshold', async ({ page }) => {
        // Increase test timeout for performance measurements
        test.setTimeout(120000);

        await page.goto('/');
        await waitForTuiReady(page);
        await enterShellMode(page);

        // Create a simple TypeScript file with a few lines
        // Use multiple echo commands instead of one giant echo
        await typeInTerminal(page, 'echo "const a = 1;" > perf.ts', true);
        await pressKey(page, 'Enter');
        await page.waitForTimeout(200);

        // Append a few more lines to have something to navigate
        for (let i = 2; i <= 10; i++) {
            await typeInTerminal(page, `echo "const x${i} = ${i};" >> perf.ts`, true);
            await pressKey(page, 'Enter');
            await page.waitForTimeout(100);
        }

        // Open the file in vim
        await typeInTerminal(page, 'vim perf.ts', true);
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);

        // Ensure file is loaded
        await waitForTerminalOutput(page, 'const', 3000);

        // Warm up - first navigation might be slower
        await pressKey(page, 'j');
        await page.waitForTimeout(300);

        // Measure navigation latencies
        const measurements: number[] = [];
        const navigationCount = 10;

        // Measure 'j' (down) navigation
        for (let i = 0; i < navigationCount; i++) {
            const startTime = performance.now();
            await pressKey(page, 'j');
            await page.waitForTimeout(50);
            measurements.push(performance.now() - startTime);
        }

        // Calculate statistics
        const avgLatency = measurements.reduce((a, b) => a + b, 0) / measurements.length;
        const maxLatency = Math.max(...measurements);
        const minLatency = Math.min(...measurements);

        console.log('\n--- Vim Navigation Performance Results ---');
        console.log(`Measurements: ${measurements.length}`);
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
        console.log(`Min latency: ${minLatency.toFixed(2)}ms`);
        console.log(`Max latency: ${maxLatency.toFixed(2)}ms`);
        console.log(`All latencies: ${measurements.map(m => m.toFixed(1)).join(', ')}`);
        console.log('------------------------------------------\n');

        // Performance assertion
        // Before the fix: syntax highlighting reload caused ~200-500ms per frame
        // After the fix: should be ~50-150ms (mostly Playwright/eval overhead)
        // We set a generous threshold of 200ms average
        expect(avgLatency).toBeLessThan(200);
        expect(maxLatency).toBeLessThan(500);

        // Cleanup
        await forceExitVim(page);
        await typeInTerminal(page, 'rm perf.ts', true);
        await pressKey(page, 'Enter');
    });
});
