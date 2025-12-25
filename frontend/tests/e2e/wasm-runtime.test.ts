/**
 * WASM Runtime E2E Tests
 * 
 * Tests the actual WASM component running in a real browser environment.
 * Uses Playwright to automate browser testing and interact with the sandbox worker.
 * 
 * NOTE: The browser uses OPFS (async filesystem), so sync fs operations are not available.
 * These tests verify what actually works in the browser environment.
 */

import { test, expect, Page } from '@playwright/test';

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

// Helper to read a file via the sandbox MCP tool (async)
async function readFile(page: Page, path: string): Promise<string> {
    const result = await page.evaluate(async (path) => {
        // @ts-expect-error - window.testHarness is set up by our test page
        const harness = window.testHarness;
        if (!harness) {
            throw new Error('Test harness not initialized');
        }
        return await harness.readFile(path);
    }, path);

    return result as string;
}

test.describe('WASM Core Functionality', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('tsx can execute console.log', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(\'Hello WASM\')"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('Hello WASM');
    });

    test('tsx supports TypeScript syntax', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "const add = (a: number, b: number): number => a + b; console.log(add(2, 3))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('5');
    });

    test('tsx supports top-level await', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "const x = await Promise.resolve(42); console.log(x)"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('42');
    });
});

test.describe('WASM Path Module', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('path.join works correctly', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(path.join(\'/a\', \'b\', \'c\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('/a/b/c');
    });

    test('path.dirname extracts directory', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(path.dirname(\'/a/b/file.txt\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('/a/b');
    });

    test('path.basename extracts filename', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(path.basename(\'/a/b/file.txt\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('file.txt');
    });

    test('path.extname extracts extension', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(path.extname(\'/a/b/file.txt\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('.txt');
    });

    test('path.normalize handles ../', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(path.normalize(\'/a/b/../c\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('/a/c');
    });
});

test.describe('WASM Buffer Module', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('Buffer.from string works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(Buffer.from(\'hello\').toString())"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('hello');
    });

    test('Buffer.from hex encoding works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(Buffer.from(\'68656c6c6f\', \'hex\').toString())"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('hello');
    });

    test('Buffer.toString base64 works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(Buffer.from(\'hello\').toString(\'base64\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('aGVsbG8=');
    });

    test('Buffer.isBuffer works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(Buffer.isBuffer(Buffer.from(\'a\')))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('true');
    });
});

test.describe('WASM URL Module', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('URL parsing works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(new URL(\'https://example.com/path\').hostname)"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('example.com');
    });

    test('URLSearchParams works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(new URL(\'https://example.com?a=1\').searchParams.get(\'a\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('1');
    });

    test('URL origin works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(new URL(\'https://example.com:8080/path\').origin)"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('https://example.com:8080');
    });
});

test.describe('WASM Encoding Module', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('TextEncoder works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(new TextEncoder().encode(\'hello\').length)"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('5');
    });

    test('TextDecoder works', async ({ page }) => {
        const result = await shellEval(page, `tsx -e "
            const enc = new TextEncoder();
            const dec = new TextDecoder();
            console.log(dec.decode(enc.encode('hello')));
        "`);
        expect(result.success).toBe(true);
        expect(result.output).toContain('hello');
    });

    test('btoa works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(btoa(\'hello\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('aGVsbG8=');
    });

    test('atob works', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "console.log(atob(\'aGVsbG8=\'))"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('hello');
    });
});

test.describe('WASM Async FS (fs.promises)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('fs.promises.writeFile and readFile work', async ({ page }) => {
        const result = await shellEval(page, `tsx -e "
            await fs.promises.writeFile('/async-test.txt', 'async content');
            const content = await fs.promises.readFile('/async-test.txt');
            console.log(content);
        "`);
        expect(result.success).toBe(true);
        expect(result.output).toContain('async content');
    });

    test('fs.promises.readdir works', async ({ page }) => {
        const result = await shellEval(page, `tsx -e "
            const entries = await fs.promises.readdir('/');
            console.log('isArray:', Array.isArray(entries));
        "`);
        expect(result.success).toBe(true);
        expect(result.output).toContain('isArray: true');
    });

    test('fs.promises.mkdir and rmdir work', async ({ page }) => {
        const result = await shellEval(page, `tsx -e "
            await fs.promises.mkdir('/test-async-dir');
            const stat = await fs.promises.stat('/test-async-dir');
            console.log('created:', stat.isDirectory());
            await fs.promises.rmdir('/test-async-dir');
        "`);
        expect(result.success).toBe(true);
        expect(result.output).toContain('created: true');
    });
});

test.describe('MCP Tools', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            // @ts-expect-error - window.testHarness is set up when ready
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('write_file and read_file tools work', async ({ page }) => {
        await writeFile(page, '/mcp-test.txt', 'hello mcp');
        const content = await readFile(page, '/mcp-test.txt');
        expect(content).toBe('hello mcp');
    });

    test('shell_eval can run echo', async ({ page }) => {
        const result = await shellEval(page, 'echo "Hello from shell"');
        expect(result.success).toBe(true);
        expect(result.output).toContain('Hello from shell');
    });
});
