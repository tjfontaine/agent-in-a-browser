/**
 * WebKit SharedArrayBuffer Diagnostic Test
 * 
 * Tests if SharedArrayBuffer is available in WebKit with COOP/COEP headers.
 */

import { test, expect } from './webkit-persistent-fixture';

test.describe('WebKit SharedArrayBuffer Diagnostics', () => {
    test('SharedArrayBuffer available in main thread', async ({ page }) => {
        // Capture all console logs
        const logs: string[] = [];
        page.on('console', msg => {
            logs.push(`[${msg.type()}] ${msg.text()}`);
        });

        await page.goto('/wasm-test.html');

        // Check if SharedArrayBuffer is available
        const result = await page.evaluate(() => {
            try {
                const sab = new SharedArrayBuffer(1024);
                return {
                    available: true,
                    crossOriginIsolated: (window as any).crossOriginIsolated,
                    sabSize: sab.byteLength,
                };
            } catch (e) {
                return {
                    available: false,
                    error: String(e),
                    crossOriginIsolated: (window as any).crossOriginIsolated,
                };
            }
        });

        console.log('SharedArrayBuffer check:', JSON.stringify(result, null, 2));
        console.log('Console logs:', logs);

        expect(result.crossOriginIsolated).toBe(true);
        expect(result.available).toBe(true);
    });

    test('Worker creation works', async ({ page }) => {
        await page.goto('/wasm-test.html');

        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                try {
                    const worker = new Worker(
                        URL.createObjectURL(new Blob([`
                            self.onmessage = (e) => {
                                try {
                                    const sab = new SharedArrayBuffer(1024);
                                    self.postMessage({
                                        type: 'result',
                                        sabAvailable: true,
                                        crossOriginIsolated: self.crossOriginIsolated
                                    });
                                } catch (err) {
                                    self.postMessage({
                                        type: 'result',
                                        sabAvailable: false,
                                        error: String(err),
                                        crossOriginIsolated: self.crossOriginIsolated
                                    });
                                }
                            };
                        `], { type: 'text/javascript' })),
                        { type: 'module' }
                    );

                    worker.onmessage = (e) => {
                        resolve({ workerCreated: true, ...e.data });
                        worker.terminate();
                    };
                    worker.onerror = (e) => {
                        resolve({ workerCreated: false, error: e.message });
                    };

                    worker.postMessage('test');

                    // Timeout after 5 seconds
                    setTimeout(() => resolve({ workerCreated: false, error: 'timeout' }), 5000);
                } catch (e) {
                    resolve({ workerCreated: false, error: String(e) });
                }
            });
        });

        console.log('Worker creation result:', JSON.stringify(result, null, 2));
        expect((result as any).workerCreated).toBe(true);
        expect((result as any).sabAvailable).toBe(true);
    });

    test('TUI page loads without crash', async ({ page }) => {
        // Capture all console logs
        const logs: string[] = [];
        page.on('console', msg => {
            logs.push(`[${msg.type()}] ${msg.text()}`);
        });

        page.on('pageerror', error => {
            logs.push(`[PAGE ERROR] ${error.message}`);
        });

        // Try to load the main page
        const response = await page.goto('/', { timeout: 30000 });

        console.log('Page load response status:', response?.status());

        // Wait a bit for the page to start loading modules
        await page.waitForTimeout(5000);

        console.log('Console logs:', logs.join('\n'));

        // Check if page is still open (didn't crash)
        const pageTitle = await page.title();
        console.log('Page title:', pageTitle);

        expect(response?.status()).toBe(200);
    });
});
