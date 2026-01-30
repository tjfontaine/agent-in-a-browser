/**
 * JSPI Context Diagnostic Test
 * 
 * Tests JSPI in main thread, dedicated Worker, and SharedWorker.
 * Uses localhost:8080 page to allow SharedWorker creation.
 * 
 * NOTE: WebKit/Safari does not support JSPI, so these tests are skipped on webkit.
 */

import { test, expect } from '@playwright/test';

test.describe('JSPI Minimal Diagnostics', () => {
    // Skip on WebKit - JSPI is not supported
    test.skip(({ browserName }) => browserName === 'webkit', 'JSPI not supported on WebKit');

    // Use the real server for SharedWorker support (origin can't be 'null')
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:8080/');
    });

    test('JSPI availability in main thread', async ({ page }) => {
        const result = await page.evaluate(() => {
            const hasJSPI = typeof (WebAssembly as any).Suspending !== 'undefined';
            const hasPromising = typeof (WebAssembly as any).promising !== 'undefined';

            return {
                hasJSPI,
                hasPromising,
                suspendingType: typeof (WebAssembly as any).Suspending,
                promisingType: typeof (WebAssembly as any).promising,
            };
        });

        console.log('Main thread JSPI check:', JSON.stringify(result));
        expect(result.hasJSPI || result.hasPromising).toBe(true);
    });

    test('JSPI availability in dedicated Worker', async ({ page }) => {
        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const workerCode = `
                    const hasJSPI = typeof WebAssembly.Suspending !== 'undefined';
                    const hasPromising = typeof WebAssembly.promising !== 'undefined';
                    
                    postMessage({
                        hasJSPI,
                        hasPromising,
                        suspendingType: typeof WebAssembly.Suspending,
                        promisingType: typeof WebAssembly.promising,
                    });
                `;

                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                const worker = new Worker(url);

                worker.onmessage = (e) => {
                    URL.revokeObjectURL(url);
                    worker.terminate();
                    resolve(e.data);
                };

                worker.onerror = (e) => resolve({ error: String(e) });
                setTimeout(() => resolve({ error: 'Timeout' }), 5000);
            });
        });

        console.log('Dedicated Worker JSPI check:', JSON.stringify(result));
        expect((result as any).hasJSPI || (result as any).hasPromising).toBe(true);
    });

    test('JSPI availability in SharedWorker', async ({ page }) => {
        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const workerCode = `
                    self.onconnect = (e) => {
                        const port = e.ports[0];
                        
                        const hasJSPI = typeof WebAssembly.Suspending !== 'undefined';
                        const hasPromising = typeof WebAssembly.promising !== 'undefined';
                        
                        port.postMessage({
                            hasJSPI,
                            hasPromising,
                            suspendingType: typeof WebAssembly.Suspending,
                            promisingType: typeof WebAssembly.promising,
                        });
                    };
                `;

                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);

                try {
                    const worker = new SharedWorker(url, { type: 'classic' });

                    worker.port.onmessage = (e) => {
                        URL.revokeObjectURL(url);
                        resolve(e.data);
                    };

                    worker.onerror = (e: any) => resolve({ error: `SharedWorker error: ${e.message || e}` });
                    worker.port.start();

                    setTimeout(() => resolve({ error: 'Timeout' }), 5000);
                } catch (e) {
                    resolve({ error: `SharedWorker creation: ${e}` });
                }
            });
        });

        console.log('SharedWorker JSPI check:', JSON.stringify(result));
        expect((result as any).hasJSPI || (result as any).hasPromising).toBe(true);
    });
});
