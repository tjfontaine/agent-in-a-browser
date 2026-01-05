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
        baseURL: 'http://localhost:3000',
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
                    // Enable experimental web platform features for JSPI
                    // Note: JSPI (--experimental-wasm-stack-switching) is now enabled by default in Chrome 137+
                    args: [
                        '--enable-experimental-web-platform-features',
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

    /* Run local dev server before starting the tests */
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
        stdout: 'pipe',
        stderr: 'pipe',
    },

});
