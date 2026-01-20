import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for WASM integration tests.
 * Tests run against src/wasm-test.html which loads the WASM component.
 */
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
                // Use system Chrome for JSPI support - only for local testing (not CI/Docker)
                ...(process.env.CI ? {} : { channel: 'chrome' }),
                launchOptions: {
                    // Enable JSPI (JavaScript Promise Integration) for WASM async operations
                    // This is critical for CI where bundled Chromium needs explicit flag
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

    /* Serve the pre-built production dist folder directly with a static file server.
     * This completely bypasses Vite which has module resolution issues causing
     * incorrect Pollable class imports. Uses npx serve with serve.json config. */
    webServer: {
        // Serve the pre-built dist folder - assumes build was run separately
        command: 'npx serve -l tcp://0.0.0.0:8080 dist',
        url: 'http://localhost:8080',
        reuseExistingServer: !process.env.CI,
        timeout: 30 * 1000, // 30 seconds for serve to start
        stdout: 'pipe',
        stderr: 'pipe',
    },

});
