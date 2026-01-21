/**
 * WASM Runtime E2E Tests
 * 
 * Tests the actual WASM component running in a real browser environment.
 * Uses Playwright to automate browser testing and interact with the sandbox worker.
 * 
 * NOTE: The browser uses OPFS (async filesystem), so sync fs operations are not available.
 * These tests verify what actually works in the browser environment.
 */

// Use webkit-persistent-fixture for OPFS support in Safari/WebKit
import { test, expect } from './webkit-persistent-fixture';
import type { Page } from '@playwright/test';

// Helper to execute commands through the sandbox worker
async function shellEval(page: Page, command: string): Promise<{ output: string; success: boolean; error?: string }> {
    const result = await page.evaluate(async (cmd) => {
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
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('fs.writeFileSync and readFileSync work', async ({ page }) => {
        // Write file using sync API
        const writeResult = await shellEval(page, 'tsx -e "fs.writeFileSync(\\"/sync-test.txt\\", \\"sync content\\"); console.log(\\"write done\\");"');
        expect(writeResult.success).toBe(true);
        expect(writeResult.output).toContain('write done');

        // Read file back using sync API (separate command to avoid buffering issues)
        const readResult = await shellEval(page, 'tsx -e "console.log(fs.readFileSync(\\"/sync-test.txt\\"));"');
        expect(readResult.success).toBe(true);
        expect(readResult.output).toContain('sync content');

        // Cleanup
        await shellEval(page, 'rm /sync-test.txt');
    });

    test('fs.promises.writeFile and readFile work', async ({ page }) => {
        const result = await shellEval(page, 'tsx -e "await fs.promises.writeFile(\\"/tmp/async-test.txt\\", \\"async content\\"); console.log(await fs.promises.readFile(\\"/tmp/async-test.txt\\"));"');
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

test.describe('Shell Glob Expansion', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('glob * expands to matching files', async ({ page }) => {
        // Create test files
        await writeFile(page, '/globtest/file1.txt', 'content1');
        await writeFile(page, '/globtest/file2.txt', 'content2');
        await writeFile(page, '/globtest/other.rs', 'rust');

        // Test glob expansion with *.txt
        const result = await shellEval(page, 'echo /globtest/*.txt');
        expect(result.success).toBe(true);
        expect(result.output).toContain('file1.txt');
        expect(result.output).toContain('file2.txt');
        expect(result.output).not.toContain('other.rs');
    });

    test('glob ? expands to single character match', async ({ page }) => {
        // Create test files
        await writeFile(page, '/globtest2/a1.txt', '');
        await writeFile(page, '/globtest2/a2.txt', '');
        await writeFile(page, '/globtest2/b1.txt', '');

        // Test ? pattern
        const result = await shellEval(page, 'echo /globtest2/a?.txt');
        expect(result.success).toBe(true);
        expect(result.output).toContain('a1.txt');
        expect(result.output).toContain('a2.txt');
        expect(result.output).not.toContain('b1.txt');
    });

    test('rm with glob deletes matching files', async ({ page }) => {
        // Create test files
        await writeFile(page, '/rmtest/del1.txt', 'delete me');
        await writeFile(page, '/rmtest/del2.txt', 'delete me too');
        await writeFile(page, '/rmtest/keep.rs', 'keep this');

        // Delete only .txt files using glob
        const rmResult = await shellEval(page, 'rm /rmtest/*.txt');
        expect(rmResult.success).toBe(true);

        // Verify .txt files are gone
        const lsResult = await shellEval(page, 'ls /rmtest');
        expect(lsResult.success).toBe(true);
        expect(lsResult.output).not.toContain('del1.txt');
        expect(lsResult.output).not.toContain('del2.txt');
        expect(lsResult.output).toContain('keep.rs');
    });
});

test.describe('Archive Commands', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    test('gzip compresses and gunzip decompresses', async ({ page }) => {
        // Create a test file
        await writeFile(page, '/gztest/file.txt', 'hello gzip world');

        // Compress with gzip  
        const gzipResult = await shellEval(page, 'gzip -k /gztest/file.txt');
        expect(gzipResult.success).toBe(true);

        // Verify .gz file exists
        const lsResult = await shellEval(page, 'ls /gztest');
        expect(lsResult.success).toBe(true);
        expect(lsResult.output).toContain('file.txt.gz');

        // Decompress with zcat to stdout
        const zcatResult = await shellEval(page, 'zcat /gztest/file.txt.gz');
        expect(zcatResult.success).toBe(true);
        expect(zcatResult.output).toContain('hello gzip world');
    });

    test('tar creates and extracts archives', async ({ page }) => {
        // Create test files
        await writeFile(page, '/tartest/src/a.txt', 'file a');
        await writeFile(page, '/tartest/src/b.txt', 'file b');

        // Create tar archive
        const createResult = await shellEval(page, 'cd /tartest/src && tar -cvf /tartest/archive.tar a.txt b.txt');
        expect(createResult.success).toBe(true);

        // List archive contents
        const listResult = await shellEval(page, 'tar -tvf /tartest/archive.tar');
        expect(listResult.success).toBe(true);
        expect(listResult.output).toContain('a.txt');
        expect(listResult.output).toContain('b.txt');
    });

    test('zip creates and unzip extracts', async ({ page }) => {
        // Create test file
        await writeFile(page, '/ziptest/file.txt', 'zip content here');

        // Create zip archive
        const zipResult = await shellEval(page, 'cd /ziptest && zip archive.zip file.txt');
        expect(zipResult.success).toBe(true);

        // List zip contents
        const listResult = await shellEval(page, 'unzip -l /ziptest/archive.zip');
        expect(listResult.success).toBe(true);
        expect(listResult.output).toContain('file.txt');
    });
});

test.describe('Git Commands', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wasm-test.html');
        await page.waitForFunction(() => {
            return window.testHarness?.ready === true;
        }, { timeout: 30000 });
    });

    // TODO: git init/status hang indefinitely in WASM context
    // - git help/version work fine
    // - git init causes deadlock, never creates .git directory
    // - Once hung, all subsequent commands hang until page refresh
    // - Root cause is likely in isomorphic-git WASM initialization
    // - Requires separate investigation of opfs-git-adapter.ts

    test('git init creates a repository', async ({ page }) => {
        // First git operation triggers lazy loading of isomorphic-git, needs extra time
        test.slow();

        // Create directory and init
        const mkdirResult = await shellEval(page, 'mkdir -p /gitrepo');
        expect(mkdirResult.success).toBe(true);

        const initResult = await shellEval(page, 'cd /gitrepo && git init');
        expect(initResult.success).toBe(true);
        expect(initResult.output).toContain('Initialized');

        // Verify .git directory exists
        const lsResult = await shellEval(page, 'ls -a /gitrepo');
        expect(lsResult.success).toBe(true);
        expect(lsResult.output).toContain('.git');
    });

    test('git status shows repository state', async ({ page }) => {
        // Git operations trigger lazy loading of isomorphic-git, needs extra time
        test.slow();

        // Create and init repo
        await shellEval(page, 'mkdir -p /gitrepo2');
        await shellEval(page, 'cd /gitrepo2 && git init');

        // Check status
        const statusResult = await shellEval(page, 'cd /gitrepo2 && git status');
        expect(statusResult.success).toBe(true);
        expect(statusResult.output).toContain('On branch');
    });

    test('git help shows available commands', async ({ page }) => {
        const helpResult = await shellEval(page, 'git --help');
        expect(helpResult.success).toBe(true);
        expect(helpResult.output).toContain('init');
        expect(helpResult.output).toContain('status');
        expect(helpResult.output).toContain('commit');
    });
});
