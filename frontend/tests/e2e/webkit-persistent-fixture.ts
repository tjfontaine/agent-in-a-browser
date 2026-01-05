/**
 * Shared WebKit Persistent Context Fixture
 * 
 * Provides a persistent context for WebKit tests that require OPFS support.
 * WebKit's ephemeral context doesn't support OPFS storage, so tests that
 * need OPFS must use launchPersistentContext() instead.
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

/**
 * Custom test fixture that automatically uses persistent context for WebKit
 * and normal context for other browsers.
 */
export const test = base.extend<{ page: Page }>({
    page: async ({ page, browserName, baseURL }, use) => {
        if (browserName === 'webkit') {
            // WebKit needs persistent context for OPFS
            const userDataDir = mkdtempSync(path.join(tmpdir(), 'playwright-webkit-opfs-'));

            const context: BrowserContext = await webkit.launchPersistentContext(userDataDir, {
                headless: true,
                baseURL: baseURL || 'http://localhost:3000',
            });

            const persistentPage = context.pages()[0] || await context.newPage();

            await use(persistentPage);

            await context.close();
            try {
                rmSync(userDataDir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[Fixture Cleanup] Failed to remove temp dir: ${e}`);
            }
        } else {
            // For other browsers, use the normal page
            await use(page);
        }
    },
});

export { expect } from '@playwright/test';
