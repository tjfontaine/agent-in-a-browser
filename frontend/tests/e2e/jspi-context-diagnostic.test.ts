/**
 * JSPI Context Diagnostic Test
 * 
 * Tests whether JSPI (WebAssembly.Suspending) works correctly in:
 * 1. Main thread
 * 2. SharedWorker context
 * 
 * This helps diagnose the "Not a valid Descriptor resource" error
 * where openAt returns a Promise instead of the resolved Descriptor.
 */

import { test, expect } from '@playwright/test';

test.describe('JSPI Context Diagnostics', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        // Wait for page to be ready
        await page.waitForFunction(() => (window as any).testHarnessReady === true, {
            timeout: 30000,
        });
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

        console.log('Main thread JSPI check:', result);

        // Log for debugging
        expect(result.hasJSPI || result.hasPromising).toBe(true);
    });

    test('JSPI basic async function in main thread', async ({ page }) => {
        // Test if WebAssembly.Suspending can wrap an async function in main thread
        const result = await page.evaluate(async () => {
            try {
                const Suspending = (WebAssembly as any).Suspending;
                if (!Suspending) {
                    return { error: 'WebAssembly.Suspending not available' };
                }

                // Create a simple async function
                const asyncFn = async (x: number) => {
                    await new Promise(r => setTimeout(r, 10));
                    return x * 2;
                };

                // Wrap it with Suspending
                const suspended = new Suspending(asyncFn);

                // Call it directly (not from WASM, just to see if it works)
                const directResult = await suspended(5);

                return {
                    success: true,
                    directResult,
                    suspendedType: typeof suspended,
                };
            } catch (e) {
                return { error: String(e) };
            }
        });

        console.log('Main thread Suspending test:', result);

        if (result.error) {
            console.log('Error:', result.error);
        } else {
            expect(result.directResult).toBe(10);
        }
    });

    test('Check hasJSPI value in SharedWorker via postMessage', async ({ page }) => {
        // Query the SharedWorker to check its JSPI detection
        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                // Create a test SharedWorker that just checks JSPI
                const workerCode = `
                    const hasJSPI = typeof WebAssembly.Suspending !== 'undefined';
                    const hasPromising = typeof WebAssembly.promising !== 'undefined';
                    
                    self.onconnect = (e) => {
                        const port = e.ports[0];
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
                    worker.port.start();

                    // Timeout after 5s
                    setTimeout(() => resolve({ error: 'Timeout waiting for SharedWorker response' }), 5000);
                } catch (e) {
                    resolve({ error: String(e) });
                }
            });
        });

        console.log('SharedWorker JSPI check:', result);

        // Both should have JSPI if Chrome supports it
        expect((result as any).hasJSPI || (result as any).hasPromising).toBe(true);
    });

    test('Test Suspending async behavior in SharedWorker', async ({ page }) => {
        // Test if Suspending correctly awaits in SharedWorker
        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const workerCode = `
                    self.onconnect = async (e) => {
                        const port = e.ports[0];
                        
                        try {
                            const Suspending = WebAssembly.Suspending;
                            if (!Suspending) {
                                port.postMessage({ error: 'WebAssembly.Suspending not available' });
                                return;
                            }

                            // Create async function that returns a Promise
                            const asyncFn = async (x) => {
                                await new Promise(r => setTimeout(r, 10));
                                return { value: x * 2, isPromise: false };
                            };

                            // Wrap with Suspending
                            const suspended = new Suspending(asyncFn);
                            
                            // Call it - if JSPI works, this should return the resolved value
                            // If JSPI doesn't work, this returns a Promise
                            const rawResult = suspended(5);
                            
                            // Check if it's a Promise
                            const isPromise = rawResult instanceof Promise;
                            const resolvedResult = isPromise ? await rawResult : rawResult;
                            
                            port.postMessage({
                                rawResultType: typeof rawResult,
                                rawResultIsPromise: isPromise,
                                rawResultConstructor: rawResult?.constructor?.name,
                                resolvedResult,
                            });
                        } catch (e) {
                            port.postMessage({ error: String(e) });
                        }
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
                    worker.port.start();

                    setTimeout(() => resolve({ error: 'Timeout' }), 5000);
                } catch (e) {
                    resolve({ error: String(e) });
                }
            });
        });

        console.log('SharedWorker Suspending behavior:', result);

        // Key diagnostic: does Suspending return a Promise or the resolved value?
        // If rawResultIsPromise is true, JSPI isn't suspending in SharedWorker
        const r = result as any;
        if (r.error) {
            console.log('Error:', r.error);
        } else {
            console.log('Raw result is Promise:', r.rawResultIsPromise);
            console.log('Raw result constructor:', r.rawResultConstructor);
        }
    });
});
