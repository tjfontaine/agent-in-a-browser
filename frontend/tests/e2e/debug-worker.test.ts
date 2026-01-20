/**
 * Debug test to capture ALL console logs from workers
 * This helps identify exactly where module evaluation is blocking
 */
import { test, expect } from '@playwright/test';

test('debug: capture worker console logs', async ({ page }) => {
    // Collect ALL console messages including from workers
    const consoleLogs: string[] = [];

    page.on('console', (msg) => {
        const text = msg.text();
        consoleLogs.push(`[${msg.type()}] ${text}`);
        console.log(`BROWSER: [${msg.type()}] ${text}`);
    });

    // Also capture page errors
    page.on('pageerror', (err) => {
        consoleLogs.push(`[page-error] ${err.message}`);
        console.log(`BROWSER ERROR: ${err.message}`);
    });

    // Navigate and wait a short time
    await page.goto('/wasm-test.html');

    // Wait 5 seconds to see what logs appear
    await page.waitForTimeout(5000);

    // Print all collected logs
    console.log('\n=== ALL CONSOLE LOGS ===');
    consoleLogs.forEach((log, i) => console.log(`${i}: ${log}`));
    console.log('=== END LOGS ===\n');

    // Check key expectations
    const hasSandboxWorkerLoading = consoleLogs.some(l => l.includes('[SandboxWorker] Module loading'));
    const hasSandboxWorkerReady = consoleLogs.some(l => l.includes('[SandboxWorker] Sending ready signal'));
    const hasError = consoleLogs.some(l => l.includes('error') || l.includes('Error'));

    console.log(`[SandboxWorker] Module loading: ${hasSandboxWorkerLoading}`);
    console.log(`[SandboxWorker] Sending ready signal: ${hasSandboxWorkerReady}`);
    console.log(`Has errors: ${hasError}`);

    // This test is just for debugging - always pass but output findings
    expect(true).toBe(true);
});
