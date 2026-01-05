/**
 * HTTP API Key Test
 * 
 * Tests HTTP requests with Authorization headers work correctly.
 * Uses httpbin.org to echo headers and verify API key transmission.
 * 
 * This test validates both execution paths:
 * - Chromium: JSPI mode with async fetch
 * - WebKit: Sync mode with synchronous XMLHttpRequest
 */

import { test, expect } from './webkit-persistent-fixture';
import type { Page } from '@playwright/test';

// No skip - runs on both Chromium and WebKit

// Helper to execute commands through the sandbox worker
async function shellEval(page: Page, command: string): Promise<{ output: string; success: boolean; error?: string }> {
    const result = await page.evaluate(async (cmd) => {
        // @ts-expect-error - window.testHarness is set up by our test page
        const harness = window.testHarness;
        if (!harness) {
            throw new Error('Test harness not initialized');
        }
        return await harness.shellEval(cmd);
    }, command);

    return result as { output: string; success: boolean; error?: string };
}

// Helper to write a file via the sandbox MCP tool (async)
async function writeFile(page: Page, path: string, content: string): Promise<void> {
    await page.evaluate(async ({ path, content }) => {
        // @ts-expect-error - window.testHarness is set up by our test page
        const harness = window.testHarness;
        if (!harness) {
            throw new Error('Test harness not initialized');
        }
        await harness.writeFile(path, content);
    }, { path, content });
}

test.describe('WebKit HTTP with API Key', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('fetch with Authorization Bearer header works', async ({ page }) => {
        // Write a tsx script file to avoid shell escaping issues with braces
        const script = `
const headers = new Headers();
headers.set('Authorization', 'Bearer test-api-key-12345');
const res = await fetch('https://httpbin.org/headers', { headers });
const data = await res.json();
console.log(JSON.stringify(data.headers));
`;
        await writeFile(page, '/http-test-auth.ts', script);
        const result = await shellEval(page, 'tsx /http-test-auth.ts');

        console.log('Result output:', result.output);
        console.log('Result success:', result.success);
        console.log('Result error:', result.error);

        expect(result.success).toBe(true);
        // Verify the Authorization header was transmitted
        expect(result.output).toContain('Bearer test-api-key-12345');
    });

    test('fetch with custom X-Api-Key header works', async ({ page }) => {
        const script = `
const headers = new Headers();
headers.set('X-Api-Key', 'my-custom-api-key');
const res = await fetch('https://httpbin.org/headers', { headers });
const data = await res.json();
console.log(JSON.stringify(data.headers));
`;
        await writeFile(page, '/http-test-apikey.ts', script);
        const result = await shellEval(page, 'tsx /http-test-apikey.ts');

        console.log('Result output:', result.output);
        console.log('Result success:', result.success);

        expect(result.success).toBe(true);
        expect(result.output).toContain('my-custom-api-key');
    });

    test('fetch POST with JSON body and auth headers', async ({ page }) => {
        // Use file-based tsx to avoid shell brace expansion issues
        const script = `
const headers = new Headers();
headers.set('Authorization', 'Bearer sk-test-key');
headers.set('Content-Type', 'application/json');
const options = {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ prompt: 'Hello AI' })
};
const res = await fetch('https://httpbin.org/post', options);
const data = await res.json();
console.log('auth:', data.headers.Authorization || data.headers.authorization);
console.log('body:', data.data);
`;
        await writeFile(page, '/http-test-post.ts', script);
        const result = await shellEval(page, 'tsx /http-test-post.ts');

        console.log('Result output:', result.output);
        console.log('Result success:', result.success);
        console.log('Result error:', result.error);

        expect(result.success).toBe(true);
        expect(result.output).toContain('Bearer sk-test-key');
        expect(result.output).toContain('Hello AI');
    });
});
