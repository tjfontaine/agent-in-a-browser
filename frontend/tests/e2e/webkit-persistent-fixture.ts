/**
 * Shared WebKit Persistent Context Fixture
 *
 * Provides a persistent context for WebKit tests that require OPFS support.
 * WebKit's ephemeral context doesn't support OPFS storage, so tests that
 * need OPFS must use launchPersistentContext() instead.
 *
 * Also handles forced sync-mode testing for the 'chromium-sync' and 'firefox'
 * projects by injecting a script that deletes WebAssembly.Suspending before
 * any page code runs, forcing the sync-worker execution path.
 *
 * Usage in test files:
 * ```typescript
 * import { test, expect } from './webkit-persistent-fixture';
 *
 * test('my test', async ({ page }) => {
 *     // page is a persistent context page in webkit, normal page in chromium
 * });
 * ```
 */

import { test as base, webkit, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/** Projects that should have JSPI forcibly disabled to test sync-worker mode */
const SYNC_MODE_PROJECTS = ['chromium-sync', 'firefox'];

/** Script injected before page load to strip JSPI, forcing sync-worker fallback */
const STRIP_JSPI_SCRIPT = `
    // Force sync-worker mode by removing JSPI APIs
    if (typeof WebAssembly !== 'undefined') {
        delete WebAssembly.Suspending;
        delete WebAssembly.promising;
    }
`;

async function setupCorsProxy(page: Page): Promise<void> {
    await page.route('**/cors-proxy*', async (route) => {
        const url = new URL(route.request().url());
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            await route.fulfill({ status: 400, body: 'Missing url parameter' });
            return;
        }
        try {
            const response = await fetch(targetUrl, {
                method: route.request().method(),
                headers: route.request().headers(),
            });
            const body = await response.arrayBuffer();
            await route.fulfill({
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                body: Buffer.from(body),
            });
        } catch (e) {
            await route.fulfill({
                status: 502,
                body: `Proxy error: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    });
}

/**
 * Custom test fixture that automatically uses persistent context for WebKit
 * and normal context for other browsers. Injects JSPI-stripping script for
 * sync-mode test projects.
 */
export const test = base.extend<{ page: Page }>({
    page: async ({ page, browserName, baseURL }, use, testInfo) => {
        const isSyncProject = SYNC_MODE_PROJECTS.includes(testInfo.project.name);

        if (browserName === 'webkit') {
            // WebKit needs persistent context for OPFS
            const userDataDir = mkdtempSync(path.join(tmpdir(), 'playwright-webkit-opfs-'));

            console.log(`[webkit-persistent-fixture] Creating persistent context for webkit at: ${userDataDir}, baseURL: ${baseURL}`);

            const context: BrowserContext = await webkit.launchPersistentContext(userDataDir, {
                headless: true,
                baseURL: baseURL || 'http://localhost:8080',
            });

            const persistentPage = context.pages()[0] || await context.newPage();
            console.log(`[webkit-persistent-fixture] Persistent page created for webkit`);
            await setupCorsProxy(persistentPage);

            await use(persistentPage);

            await context.close();
            try {
                rmSync(userDataDir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[Fixture Cleanup] Failed to remove temp dir: ${e}`);
            }
        } else {
            // For sync-mode projects, strip JSPI before any page code runs
            if (isSyncProject) {
                await page.addInitScript(STRIP_JSPI_SCRIPT);
            }

            await setupCorsProxy(page);
            await use(page);
        }
    },
});

export { expect } from '@playwright/test';
