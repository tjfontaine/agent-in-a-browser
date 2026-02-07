import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for WASM integration tests.
 * Tests run against src/wasm-test.html which loads the WASM component.
 */
const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === '1';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'list' : 'html',
    timeout: 60 * 1000, // 60 second timeout per test

    use: {
        // Use port 8080 for npx serve (static production build)
        baseURL: 'http://localhost:8080',
        trace: 'on-first-retry',
    },


    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // Default to Playwright's bundled Chromium for reliability in CI/sandboxed environments.
                // Opt in to system Chrome only when explicitly requested.
                ...(useSystemChrome ? { channel: 'chrome' } : {}),
                launchOptions: {
                    // Enable JSPI (JavaScript Promise Integration) for WASM async operations
                    // Keep explicit flags for portability across Chromium/Chrome versions.
                    // Note: Chrome 137+ has JSPI enabled by default
                    args: [
                        '--enable-experimental-web-platform-features',
                        '--enable-features=WebAssemblyJSPromiseIntegration',
                    ],
                },
            },
        },
        // WebKit (Safari) - enabled for debugging shim isolation issues
        // Note: OPFS behavior may differ in Playwright's ephemeral context
        {
            name: 'webkit',
            use: {
                ...devices['Desktop Safari'],
            },
        },
    ],

    /* Serve the pre-built production dist folder with vite preview.
     * Keep startup fully local and deterministic for CI/sandboxed runs. */
    webServer: {
        // Serve the pre-built dist folder - assumes build was run separately.
        command: 'pnpm exec vite preview --host 127.0.0.1 --port 8080 --strictPort',
        url: 'http://localhost:8080',
        reuseExistingServer: !process.env.CI,
        timeout: 30 * 1000, // 30 seconds for serve to start
        stdout: 'pipe',
        stderr: 'pipe',
    },

});
