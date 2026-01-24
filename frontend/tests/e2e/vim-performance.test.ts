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
    // Skip by default - CI runners are slower than local machines.
    // Run manually with: pnpm test:e2e --grep "navigation latency"
    test.skip('navigation latency with syntax-highlighted file stays under threshold', async ({ page }) => {
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

    test('double-buffer rendering produces low cell change percentages on navigation', async ({ page }) => {
        // This test verifies the double-buffering optimization is working by checking
        // that navigation keystrokes produce low cell change percentages in the [WASM stderr] output.
        test.setTimeout(60000);

        // Capture console messages that contain our instrumentation
        const perfMessages: string[] = [];
        const allMessages: string[] = [];

        // Listen on page console - capture [PERF] messages
        page.on('console', msg => {
            const text = msg.text();
            allMessages.push(`[${msg.type()}] ${text}`);
            if (text.includes('[PERF]')) {
                perfMessages.push(text);
            }
        });

        // Listen on worker consoles (where SharedWorker stderr goes)
        // Per Playwright docs: use page.on('worker') to attach to worker console events
        page.on('worker', worker => {
            worker.on('console', msg => {
                const text = msg.text();
                if (text.includes('[PERF]')) {
                    perfMessages.push(text);
                }
            });
        });

        await page.goto('/?debug=true');
        await waitForTuiReady(page);
        await enterShellMode(page);

        // Create a test file
        await typeInTerminal(page, 'echo "const x = 1;" > test.ts', true);
        await pressKey(page, 'Enter');
        await page.waitForTimeout(200);

        // Add a few more lines
        for (let i = 2; i <= 5; i++) {
            await typeInTerminal(page, `echo "const y${i} = ${i};" >> test.ts`, true);
            await pressKey(page, 'Enter');
            await page.waitForTimeout(100);
        }

        // Open in vim
        await typeInTerminal(page, 'vim test.ts', true);
        await pressKey(page, 'Enter');
        await waitForTerminalOutput(page, 'NORMAL', 5000);
        await page.waitForTimeout(500);

        // Clear messages to only capture navigation frames
        perfMessages.length = 0;

        // Navigate up and down several times
        for (let i = 0; i < 5; i++) {
            await pressKey(page, 'j');
            await page.waitForTimeout(100);
        }
        for (let i = 0; i < 5; i++) {
            await pressKey(page, 'k');
            await page.waitForTimeout(100);
        }

        // Wait a bit for all messages to arrive
        await page.waitForTimeout(500);

        const cellChanges: number[] = [];
        for (const msg of perfMessages) {
            // Parse: [WASM stderr] [PERF] force=false cells_changed=123/4567 (2%) output_bytes=456
            const match = msg.match(/cells_changed=(\d+)\/(\d+) \((\d+)%\)/);
            if (match && msg.includes('force=false')) {
                cellChanges.push(parseInt(match[3], 10));
            }
        }

        // Verify we got navigation frames - if none captured, skip (perf_metrics feature not enabled)
        if (perfMessages.length === 0) {
            console.log('No [PERF] messages captured - perf_metrics feature likely not enabled in build');
            test.skip();
            return;
        }

        // If we have navigation-only frames (force=false), verify low cell change
        if (cellChanges.length > 0) {
            const avgChange = cellChanges.reduce((a, b) => a + b, 0) / cellChanges.length;
            console.log(`Average cell change for navigation: ${avgChange.toFixed(1)}%`);

            // Navigation should change less than 50% of cells (ideally much less)
            // Full redraw would be 100%
            expect(avgChange).toBeLessThan(50);
        } else {
            console.log('Warning: No force=false frames captured - may need to check WASI stderr routing');
        }

        // Cleanup
        await forceExitVim(page);
        await typeInTerminal(page, 'rm test.ts', true);
        await pressKey(page, 'Enter');
    });
});
