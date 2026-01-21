/**
 * JSPI Context Diagnostic Test - Minimal Version
 * 
 * Tests JSPI without depending on sandbox initialization.
 * Uses about:blank page and creates inline workers.
 */

import { test, expect } from '@playwright/test';

test.describe('JSPI Minimal Diagnostics', () => {
    // Don't use wasm-test.html - just go to a minimal page
    test.beforeEach(async ({ page }) => {
        // Use about:blank - we'll evaluate everything inline
        await page.goto('about:blank');
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

        // At least one JSPI API should be available in Chrome
        expect(result.hasJSPI || result.hasPromising).toBe(true);
    });

    test('Suspending behavior in main thread (direct call)', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const Suspending = (WebAssembly as any).Suspending;
            if (!Suspending) {
                return { error: 'WebAssembly.Suspending not available', hasJSPI: false };
            }

            try {
                // Create an async function that returns a promise
                const asyncFn = async (x: number): Promise<number> => {
                    await new Promise(r => setTimeout(r, 10));
                    return x * 2;
                };

                // Wrap with Suspending
                const suspended = new Suspending(asyncFn);

                // Direct call (not from WASM) - this should return a Promise
                // that resolves to the value when awaited
                const result = suspended(5);

                // Check what we got
                const isPromise = result instanceof Promise;
                const constructorName = result?.constructor?.name;

                // If it's a Promise, await it
                const finalValue = isPromise ? await result : result;

                return {
                    hasJSPI: true,
                    rawResultIsPromise: isPromise,
                    rawResultConstructor: constructorName,
                    finalValue,
                };
            } catch (e) {
                return { hasJSPI: true, error: String(e) };
            }
        });

        console.log('Main thread Suspending direct call:', JSON.stringify(result));

        // Suspending wrapped function returns an object that when called
        // should eventually give us the resolved value
        if (!result.error) {
            expect(result.finalValue).toBe(10);
        }
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

                worker.onerror = (e) => {
                    resolve({ error: String(e) });
                };

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

                    worker.onerror = (e: any) => {
                        resolve({ error: `SharedWorker error: ${e.message || e}` });
                    };

                    worker.port.start();

                    setTimeout(() => resolve({ error: 'Timeout' }), 5000);
                } catch (e) {
                    resolve({ error: `SharedWorker creation: ${e}` });
                }
            });
        });

        console.log('SharedWorker JSPI check:', JSON.stringify(result));

        // Should have JSPI in SharedWorker too
        expect((result as any).hasJSPI || (result as any).hasPromising).toBe(true);
    });

    test('Suspending behavior in SharedWorker', async ({ page }) => {
        // KEY TEST: Does Suspending work correctly in SharedWorker?
        const result = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const workerCode = `
                    self.onconnect = async (e) => {
                        const port = e.ports[0];
                        
                        try {
                            const Suspending = WebAssembly.Suspending;
                            if (!Suspending) {
                                port.postMessage({ error: 'No Suspending', hasJSPI: false });
                                return;
                            }

                            // Create async function
                            const asyncFn = async (x) => {
                                await new Promise(r => setTimeout(r, 10));
                                return x * 2;
                            };

                            // Wrap with Suspending
                            const suspended = new Suspending(asyncFn);
                            
                            // Direct call
                            const result = suspended(5);
                            
                            // Check type
                            const isPromise = result instanceof Promise;
                            const constructorName = result?.constructor?.name;
                            
                            // Resolve if Promise
                            const finalValue = isPromise ? await result : result;
                            
                            port.postMessage({
                                hasJSPI: true,
                                rawResultIsPromise: isPromise,
                                rawResultConstructor: constructorName,
                                finalValue,
                            });
                        } catch (e) {
                            port.postMessage({ hasJSPI: true, error: String(e) });
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
                    resolve({ error: `SharedWorker: ${e}` });
                }
            });
        });

        console.log('SharedWorker Suspending behavior:', JSON.stringify(result));

        // This is the key diagnostic
        const r = result as any;
        if (!r.error) {
            console.log(`  rawResultIsPromise: ${r.rawResultIsPromise}`);
            console.log(`  rawResultConstructor: ${r.rawResultConstructor}`);
            console.log(`  finalValue: ${r.finalValue}`);

            // If finalValue is 10, JSPI/Suspending works
            expect(r.finalValue).toBe(10);
        }
    });
});
