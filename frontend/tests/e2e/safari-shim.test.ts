import { test, expect } from '@playwright/test';

/**
 * Safari Shim Isolation Test
 * 
 * This test specifically targets the Descriptor instanceof issue in Safari/WebKit.
 * It tests the worker-based module loading path used when JSPI is not available.
 */

test.describe('Safari Shim Isolation Debug', () => {

    test('debug: worker shim isolation', async ({ page }) => {
        // Collect console messages for debugging - set up BEFORE navigation
        const consoleLogs: string[] = [];
        const consoleErrors: string[] = [];

        page.on('console', msg => {
            const text = msg.text();
            if (msg.type() === 'error') {
                consoleErrors.push(text);
                console.log('[ERROR]', text);
            } else {
                consoleLogs.push(text);
                console.log('[LOG]', text);
            }
        });

        // Navigate to the TUI page
        await page.goto('/');

        // Wait for the app to initialize and potentially error
        await page.waitForTimeout(10000);

        // Log summary
        console.log('=== SUMMARY ===');
        console.log(`Total logs: ${consoleLogs.length}, Total errors: ${consoleErrors.length}`);

        // Check if we're in JSPI or non-JSPI mode
        const jspiSupport = consoleLogs.some(log => log.includes('JSPI support: YES'));
        const noJspiSupport = consoleLogs.some(log => log.includes('JSPI support: NO'));

        console.log(`JSPI Support: ${jspiSupport ? 'YES' : noJspiSupport ? 'NO' : 'UNKNOWN'}`);

        // If in non-JSPI mode, look for the Descriptor error
        if (noJspiSupport) {
            const hasDescriptorError = consoleErrors.some(err =>
                err.includes('Not a valid "Descriptor" resource')
            );

            console.log(`Descriptor Error Present: ${hasDescriptorError}`);
        }

        // Check for successful TUI launch indicators
        const tuiStarted = consoleLogs.some(log =>
            log.includes('TUI module loaded, starting run()')
        );
        console.log(`TUI Started: ${tuiStarted}`);

        // Don't fail the test - this is for debugging
        expect(true).toBe(true);
    });

    test('debug: module import paths', async ({ page }) => {
        // Set up console listener before navigation
        page.on('console', msg => {
            console.log(`[${msg.type()}]`, msg.text());
        });

        // This test injects code to verify module loading in the worker context
        await page.goto('/');

        // Wait for initial load
        await page.waitForTimeout(2000);

        // Check if window has our expected globals
        const hasJSPI = await page.evaluate(() => {
            return typeof WebAssembly !== 'undefined' &&
                typeof (WebAssembly as unknown as Record<string, unknown>).Suspending !== 'undefined';
        });

        console.log(`Browser JSPI Support: ${hasJSPI}`);

        // Verify terminal element exists
        const terminalExists = await page.locator('#terminal').isVisible();
        console.log(`Terminal element visible: ${terminalExists}`);

        expect(terminalExists).toBe(true);
    });

});
