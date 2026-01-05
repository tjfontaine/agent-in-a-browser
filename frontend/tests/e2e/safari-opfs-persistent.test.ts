import { test as base, webkit, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Safari OPFS Test with Persistent Context
 * 
 * Uses launchPersistentContext() to enable OPFS support in WebKit.
 * The default ephemeral context doesn't support OPFS storage.
 */

// Skip on non-WebKit browsers - these tests are Safari-specific
base.skip(({ browserName }) => browserName !== 'webkit', 'Safari-only test');

// Create a custom test fixture that uses persistent context
const test = base.extend<{ persistentPage: Page }>({
    persistentPage: async ({ }, use) => {
        // Create a temporary directory for user data
        const userDataDir = mkdtempSync(path.join(tmpdir(), 'playwright-webkit-opfs-'));

        console.log(`[Test Setup] Using persistent context at: ${userDataDir}`);

        // Launch WebKit with persistent context
        const context: BrowserContext = await webkit.launchPersistentContext(userDataDir, {
            headless: true,
            // These headers are required for SharedArrayBuffer (which our OPFS shim uses)
            // Note: In a real test, these would be set by the server
        });

        const page = context.pages()[0] || await context.newPage();

        // Use the page in the test
        await use(page);

        // Cleanup
        await context.close();
        try {
            rmSync(userDataDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[Test Cleanup] Failed to remove temp dir: ${e}`);
        }
    },
});

test.describe('Safari OPFS with Persistent Context', () => {

    test('debug: OPFS initialization with persistent storage', async ({ persistentPage: page }) => {
        // Collect console messages
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
        // Note: The dev server must be running on localhost:3000
        await page.goto('http://localhost:3000/');

        // Wait for the app to initialize
        await page.waitForTimeout(12000);

        // Log summary
        console.log('=== SUMMARY ===');
        console.log(`Total logs: ${consoleLogs.length}, Total errors: ${consoleErrors.length}`);

        // Check if OPFS initialized successfully
        const opfsInitSuccess = consoleLogs.some(log =>
            log.includes('Filesystem initialized with lazy loading') ||
            log.includes('OPFS filesystem ready')
        );
        const opfsInitFailed = consoleErrors.some(err =>
            err.includes('Failed to initialize OPFS')
        );

        console.log(`OPFS Init Success: ${opfsInitSuccess}`);
        console.log(`OPFS Init Failed: ${opfsInitFailed}`);

        // Check for Descriptor error
        const hasDescriptorError = consoleErrors.some(err =>
            err.includes('Not a valid "Descriptor" resource')
        );
        console.log(`Descriptor Error Present: ${hasDescriptorError}`);

        // Check if TUI started
        const tuiStarted = consoleLogs.some(log =>
            log.includes('TUI module loaded, starting run()')
        );
        console.log(`TUI Started: ${tuiStarted}`);

        // Check for stdin-request messages (indicates sync stdin is working)
        const hasStdinRequest = consoleLogs.some(log =>
            log.includes('stdin-request')
        );
        console.log(`Stdin Request Seen: ${hasStdinRequest}`);

        // Check for terminal output (TUI rendering)
        const hasTerminalOutput = consoleLogs.some(log =>
            log.includes('terminal-output')
        );
        console.log(`Terminal Output Seen: ${hasTerminalOutput}`);
    });

    test('stdin: keyboard input should reach WASM worker', async ({ persistentPage: page }) => {
        // Collect console messages
        const consoleLogs: string[] = [];
        const consoleErrors: string[] = [];

        page.on('console', msg => {
            const text = msg.text();
            if (msg.type() === 'error') {
                consoleErrors.push(text);
            } else {
                consoleLogs.push(text);
            }
            // Log stdin-related messages
            if (text.includes('stdin') || text.includes('handleTerminalInput')) {
                console.log('[STDIN]', text);
            }
        });

        // Navigate to the TUI page
        await page.goto('http://localhost:3000/');

        // Wait for TUI to fully start and render
        await page.waitForTimeout(5000);

        // Check TUI started
        const tuiStarted = consoleLogs.some(log =>
            log.includes('TUI module loaded, starting run()')
        );
        console.log(`TUI Started: ${tuiStarted}`);

        // Clear logs to focus on after-type
        const _logsAfterInit = [...consoleLogs];
        consoleLogs.length = 0;

        // Type some keys to trigger stdin
        console.log('=== TYPING KEYS ===');

        // Click on the terminal element to focus it
        const terminalElement = page.locator('#terminal').first();
        const exists = await terminalElement.count();
        console.log(`Terminal element exists: ${exists > 0}`);

        if (exists > 0) {
            await terminalElement.click();
            console.log('Clicked terminal container for focus');
        }

        await page.keyboard.type('hello');

        // Take screenshot immediately to see if terminal rendered
        await page.screenshot({ path: 'test-results/after-typing-immediate.png' });

        // Also check for terminal output flush logs
        const flushLogs = consoleLogs.filter(log => log.includes('Flushing terminal output'));
        console.log(`Terminal flush logs: ${flushLogs.length}`);
        for (const log of flushLogs) {
            console.log('[FLUSH LOG]', log);
        }

        await page.waitForTimeout(2000);

        // Take another screenshot after wait
        await page.screenshot({ path: 'test-results/after-typing-2s.png' });

        // Log all stdin-related logs after typing
        console.log('=== LOGS AFTER TYPING ===');
        const stdinLogs = consoleLogs.filter(log =>
            log.includes('stdin') ||
            log.includes('handleTerminalInput') ||
            log.includes('onData') ||
            log.includes('REQUEST_READY') ||
            log.includes('sendStdin')
        );
        for (const log of stdinLogs) {
            console.log('[STDIN LOG]', log);
        }
        console.log(`Total stdin-related logs: ${stdinLogs.length}`);

        // Check for stdin-request from worker
        const hasStdinRequest = consoleLogs.some(log =>
            log.includes('stdin-request')
        );
        console.log(`Stdin Request After Type: ${hasStdinRequest}`);

        // Summary
        console.log('=== STDIN TEST SUMMARY ===');
        console.log(`TUI started: ${tuiStarted}`);
        console.log(`Logs after typing: ${consoleLogs.length}`);
        console.log(`Stdin requests: ${hasStdinRequest}`);
    });

    test('resize: terminal resize should propagate to worker', async ({ persistentPage: page }) => {
        // Collect console messages
        const consoleLogs: string[] = [];

        page.on('console', msg => {
            consoleLogs.push(msg.text());
        });

        // Navigate to the TUI page
        await page.goto('http://localhost:3000/');

        // Wait for TUI to initialize
        await page.waitForTimeout(5000);

        // Check TUI started
        const tuiStarted = consoleLogs.some(log =>
            log.includes('TUI module loaded, starting run()')
        );
        console.log(`TUI Started: ${tuiStarted}`);

        // Clear logs to focus on resize
        consoleLogs.length = 0;

        // Trigger resize by changing viewport
        console.log('=== TRIGGERING RESIZE ===');
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.waitForTimeout(1000);

        // Check for resize-related logs
        const mainResizeLogs = consoleLogs.filter(log =>
            log.includes('Terminal resized')
        );
        const bridgeResizeLogs = consoleLogs.filter(log =>
            log.includes('Injecting resize via SharedArrayBuffer')
        );
        const workerResizeLogs = consoleLogs.filter(log =>
            log.includes('Resize injected, Atomics.notify')
        );

        console.log('=== RESIZE LOGS ===');
        console.log(`Main thread resize: ${mainResizeLogs.length}`);
        for (const log of mainResizeLogs) {
            console.log('[MAIN]', log);
        }
        console.log(`WorkerBridge resize: ${bridgeResizeLogs.length}`);
        for (const log of bridgeResizeLogs) {
            console.log('[BRIDGE]', log);
        }

        // Check for WasmWorker messages (any)
        const workerReceivedLogs = consoleLogs.filter(log =>
            log.includes('Received resize message')
        );
        const workerSkippedLogs = consoleLogs.filter(log =>
            log.includes('Resize skipped')
        );
        console.log(`WasmWorker received: ${workerReceivedLogs.length}`);
        for (const log of workerReceivedLogs) {
            console.log('[WORKER-RECV]', log);
        }
        console.log(`WasmWorker skipped: ${workerSkippedLogs.length}`);
        for (const log of workerSkippedLogs) {
            console.log('[WORKER-SKIP]', log);
        }

        console.log(`WasmWorker injected: ${workerResizeLogs.length}`);
        for (const log of workerResizeLogs) {
            console.log('[WORKER-INJECT]', log);
        }

        // Summary
        console.log('=== RESIZE TEST SUMMARY ===');
        console.log(`Main detected resize: ${mainResizeLogs.length > 0}`);
        console.log(`Bridge sent resize: ${bridgeResizeLogs.length > 0}`);
        console.log(`Worker received resize: ${workerResizeLogs.length > 0}`);
    });

});

export { test };
