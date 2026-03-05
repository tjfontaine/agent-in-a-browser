/**
 * OPFS Resilience & Coverage Tests
 *
 * Exercises OPFS filesystem operations that are critical for production
 * but missing from existing test suites:
 *   - File persistence across page reload
 *   - Large file operations (>64KB, testing SharedArrayBuffer chunking)
 *   - Error scenarios (ENOENT, stat missing, rmdir non-empty)
 *   - Symbolic links via ln -s (WASI symlink_at interface)
 *   - File rename via mv (OPFS rename implementation)
 *   - Sequential file operations (MCP is single-threaded)
 */

import { test, expect } from './webkit-persistent-fixture';
import type { Page } from '@playwright/test';

// --- helpers (same as wasm-runtime.test.ts) ---

async function shellEval(page: Page, command: string): Promise<{ output: string; success: boolean; error?: string }> {
    return await page.evaluate(async (cmd) => {
        const h = window.testHarness;
        if (!h) throw new Error('Test harness not initialized');
        return await h.shellEval(cmd);
    }, command) as { output: string; success: boolean; error?: string };
}

async function writeFile(page: Page, path: string, content: string): Promise<void> {
    await page.evaluate(async ({ path, content }) => {
        const h = window.testHarness;
        if (!h) throw new Error('Test harness not initialized');
        await h.writeFile(path, content);
    }, { path, content });
}

async function readFile(page: Page, path: string): Promise<string> {
    return await page.evaluate(async (path) => {
        const h = window.testHarness;
        if (!h) throw new Error('Test harness not initialized');
        return await h.readFile(path);
    }, path) as string;
}

async function waitForHarness(page: Page): Promise<void> {
    await page.goto('/wasm-test.html');
    await page.waitForFunction(() => window.testHarness?.ready === true, { timeout: 30000 });
}

// --- File Persistence ---

test.describe('OPFS File Persistence', () => {
    test('file survives page reload', async ({ page }) => {
        await waitForHarness(page);

        const marker = `persist-${Date.now()}`;
        await writeFile(page, '/persist-test.txt', marker);

        // Reload the page and re-initialize the harness
        await waitForHarness(page);

        const content = await readFile(page, '/persist-test.txt');
        expect(content).toBe(marker);

        // Cleanup
        await shellEval(page, 'rm /persist-test.txt');
    });

    test('directory tree survives page reload', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/persist-dir/sub/file.txt', 'nested');

        await waitForHarness(page);

        const result = await shellEval(page, 'cat /persist-dir/sub/file.txt');
        expect(result.success).toBe(true);
        expect(result.output).toContain('nested');

        await shellEval(page, 'rm -rf /persist-dir');
    });
});

// --- Large File Operations ---

test.describe('Large File Operations', () => {
    test('write and read file larger than 64KB', async ({ page }) => {
        await waitForHarness(page);

        // Generate 100KB of data via MCP write_file / read_file
        const size = 100 * 1024;
        const result = await page.evaluate(async (sz) => {
            const h = window.testHarness;
            if (!h) throw new Error('Test harness not initialized');

            const line = 'ABCDEFGHIJ'.repeat(10) + '\n'; // 101 chars per line
            const lines = Math.ceil(sz / line.length);
            const content = line.repeat(lines).slice(0, sz);

            await h.writeFile('/large-test.bin', content);
            const readBack = await h.readFile('/large-test.bin');
            return { written: content.length, readBack: readBack.length, match: content === readBack };
        }, size);

        expect(result.match).toBe(true);
        expect(result.readBack).toBe(result.written);

        await shellEval(page, 'rm /large-test.bin');
    });

    test('write and read file via shell exceeding 64KB', async ({ page }) => {
        await waitForHarness(page);

        // Use tsx to generate and verify a large file through the shell path
        // readFileSync with 'utf8' encoding should return string directly
        const result = await shellEval(page, `tsx -e "
            const content = 'A'.repeat(80 * 1024);
            fs.writeFileSync('/large-shell.txt', content);
            const back = fs.readFileSync('/large-shell.txt', 'utf8');
            console.log('len=' + back.length + ' match=' + (back === content));
        "`);
        expect(result.success).toBe(true);
        expect(result.output).toContain('len=81920');
        expect(result.output).toContain('match=true');

        await shellEval(page, 'rm /large-shell.txt');
    });
});

// --- Error Scenarios ---

test.describe('Filesystem Error Scenarios', () => {
    test('reading non-existent file returns error', async ({ page }) => {
        await waitForHarness(page);

        const result = await shellEval(page, 'cat /does-not-exist-at-all.txt');
        expect(result.success).toBe(false);
    });

    test('stat on non-existent path returns error', async ({ page }) => {
        await waitForHarness(page);

        const result = await shellEval(page, 'stat /no-such-path-xyz');
        expect(result.success).toBe(false);
    });

    test('reading a directory as a file returns error', async ({ page }) => {
        await waitForHarness(page);

        await shellEval(page, 'mkdir -p /read-dir-test');
        const result = await shellEval(page, 'cat /read-dir-test');
        expect(result.success).toBe(false);

        await shellEval(page, 'rmdir /read-dir-test');
    });

    test('rmdir on non-empty directory fails', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/rmdir-test/child.txt', 'content');
        const result = await shellEval(page, 'rmdir /rmdir-test');
        expect(result.success).toBe(false);

        // Cleanup with rm -rf which does recursive delete
        await shellEval(page, 'rm -rf /rmdir-test');
    });

    test('writing to deeply nested non-existent path auto-creates parents', async ({ page }) => {
        await waitForHarness(page);

        // MCP write_file creates parent directories
        await writeFile(page, '/deep/nested/path/file.txt', 'deep');
        const content = await readFile(page, '/deep/nested/path/file.txt');
        expect(content).toBe('deep');

        await shellEval(page, 'rm -rf /deep');
    });
});

// --- File Rename (mv) ---

test.describe('File Rename', () => {
    test('mv renames a file', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/mv-src.txt', 'move me');
        const mvResult = await shellEval(page, 'mv /mv-src.txt /mv-dst.txt');
        expect(mvResult.success).toBe(true);

        const content = await readFile(page, '/mv-dst.txt');
        expect(content).toBe('move me');

        // Original should be gone
        const catOld = await shellEval(page, 'cat /mv-src.txt');
        expect(catOld.success).toBe(false);

        await shellEval(page, 'rm /mv-dst.txt');
    });
});

// --- Symbolic Links ---

test.describe('Symbolic Links', () => {
    test('ln -s creates a symlink that resolves to target', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/symlink-target.txt', 'symlink content');

        const lnResult = await shellEval(page, 'ln -s /symlink-target.txt /symlink-link.txt');
        expect(lnResult.success).toBe(true);

        // Reading through the symlink should return target content
        const content = await shellEval(page, 'cat /symlink-link.txt');
        expect(content.success).toBe(true);
        expect(content.output).toContain('symlink content');

        // readlink should return the target path
        const rl = await shellEval(page, 'readlink /symlink-link.txt');
        expect(rl.success).toBe(true);
        expect(rl.output).toContain('/symlink-target.txt');

        await shellEval(page, 'rm /symlink-link.txt');
        await shellEval(page, 'rm /symlink-target.txt');
    });

    test('modifying target file is visible through symlink', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/sym-target2.txt', 'v1');
        await shellEval(page, 'ln -s /sym-target2.txt /sym-link2.txt');

        // Update the target
        await writeFile(page, '/sym-target2.txt', 'v2');

        const content = await shellEval(page, 'cat /sym-link2.txt');
        expect(content.success).toBe(true);
        expect(content.output).toContain('v2');

        await shellEval(page, 'rm /sym-link2.txt');
        await shellEval(page, 'rm /sym-target2.txt');
    });
});

// --- File Copy ---

test.describe('File Copy Operations', () => {
    test('cp creates a copy of a file', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/cp-src.txt', 'copy me');
        const cpResult = await shellEval(page, 'cp /cp-src.txt /cp-dst.txt');
        expect(cpResult.success).toBe(true);

        const content = await readFile(page, '/cp-dst.txt');
        expect(content).toBe('copy me');

        // Original still exists
        const srcContent = await readFile(page, '/cp-src.txt');
        expect(srcContent).toBe('copy me');

        await shellEval(page, 'rm /cp-src.txt /cp-dst.txt');
    });

    test('cp -r copies directory recursively', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/cpdir-src/a.txt', 'aaa');
        await writeFile(page, '/cpdir-src/b.txt', 'bbb');

        const cpResult = await shellEval(page, 'cp -r /cpdir-src /cpdir-dst');
        expect(cpResult.success).toBe(true);

        const a = await readFile(page, '/cpdir-dst/a.txt');
        const b = await readFile(page, '/cpdir-dst/b.txt');
        expect(a).toBe('aaa');
        expect(b).toBe('bbb');

        await shellEval(page, 'rm -rf /cpdir-src /cpdir-dst');
    });
});

// --- Sequential File Operations ---

test.describe('Sequential File Operations', () => {
    test('sequential writes to different files succeed', async ({ page }) => {
        await waitForHarness(page);

        // MCP server is single-threaded — write files sequentially
        for (let i = 0; i < 5; i++) {
            await writeFile(page, `/seq-${i}.txt`, `content-${i}`);
        }

        // Read them back sequentially and verify
        for (let i = 0; i < 5; i++) {
            const content = await readFile(page, `/seq-${i}.txt`);
            expect(content).toBe(`content-${i}`);
        }

        // Cleanup
        for (let i = 0; i < 5; i++) {
            await shellEval(page, `rm /seq-${i}.txt`);
        }
    });

    test('rapid sequential writes to same file keep last value', async ({ page }) => {
        await waitForHarness(page);

        const result = await page.evaluate(async () => {
            const h = window.testHarness;
            if (!h) throw new Error('Test harness not initialized');

            // Write to the same file 10 times sequentially
            for (let i = 0; i < 10; i++) {
                await h.writeFile('/overwrite-test.txt', `version-${i}`);
            }
            return await h.readFile('/overwrite-test.txt');
        });

        expect(result).toBe('version-9');
        await shellEval(page, 'rm /overwrite-test.txt');
    });
});

// --- Execution Mode Verification ---

test.describe('Execution Mode Detection', () => {
    test('JSPI detection matches expected state for this project', async ({ page, browserName }, testInfo) => {
        await page.goto('/wasm-test.html');

        // Check JSPI availability directly in the page context
        const jspiState = await page.evaluate(() => {
            const wasm = WebAssembly as typeof WebAssembly & { Suspending?: unknown; promising?: unknown };
            return {
                hasSuspending: typeof wasm.Suspending !== 'undefined',
                hasPromising: typeof wasm.promising !== 'undefined',
            };
        });

        const hasJSPI = jspiState.hasSuspending || jspiState.hasPromising;

        if (testInfo.project.name === 'chromium-sync' || testInfo.project.name === 'firefox') {
            // Sync projects: JSPI should be stripped by addInitScript
            expect(hasJSPI).toBe(false);
        } else if (browserName === 'chromium') {
            // Standard chromium project should have JSPI
            expect(hasJSPI).toBe(true);
        }
        // WebKit: JSPI support varies, just verify detection runs without error
    });
});

// --- Special Character Filenames ---

test.describe('Special Character Filenames', () => {
    test('files with spaces in name', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/my file.txt', 'space content');
        const content = await readFile(page, '/my file.txt');
        expect(content).toBe('space content');

        // Use MCP to clean up (shell quoting for spaces is tricky)
        await page.evaluate(async () => {
            const h = window.testHarness;
            if (!h) return;
            await h.shellEval('rm "/my file.txt"');
        });
    });

    test('files with multiline content', async ({ page }) => {
        await waitForHarness(page);

        await writeFile(page, '/multiline-test.txt', 'Hello\nLine 2\nLine 3');
        const content = await readFile(page, '/multiline-test.txt');
        expect(content).toContain('Hello');
        expect(content).toContain('Line 2');
        expect(content).toContain('Line 3');

        await shellEval(page, 'rm /multiline-test.txt');
    });
});
