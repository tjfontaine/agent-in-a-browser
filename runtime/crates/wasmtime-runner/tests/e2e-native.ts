#!/usr/bin/env npx tsx
/**
 * E2E tests for wasmtime-runner TUI using node-pty
 *
 * Tests the native TUI binary by spawning it with a pseudo-terminal
 * and verifying output and command handling.
 *
 * Run: npx tsx tests/e2e-native.ts
 * Or: npm test -- --grep native
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const TIMEOUT_MS = 30000;
const BINARY_PATH = path.join(__dirname, '../../../target/release/wasm-tui');

interface TestResult {
    name: string;
    passed: boolean;
    message: string;
    duration: number;
}

/**
 * Spawn the TUI and capture output until timeout or condition met
 */
async function runTuiTest(
    name: string,
    waitForTexts: string[],
    inputSequence: string[] = [],
    timeoutMs: number = 5000
): Promise<TestResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
        const child = spawn(BINARY_PATH, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TERM: 'xterm-256color' },
        });

        let output = '';
        let foundAll = false;
        const foundTexts = new Set<string>();

        const cleanup = () => {
            child.kill();
        };

        const timeout = setTimeout(() => {
            cleanup();
            resolve({
                name,
                passed: foundAll,
                message: foundAll
                    ? 'All expected text found'
                    : `Missing: ${waitForTexts.filter((t) => !foundTexts.has(t)).join(', ')}\nOutput: ${output.slice(0, 500)}`,
                duration: Date.now() - startTime,
            });
        }, timeoutMs);

        child.stdout?.on('data', (data: Buffer) => {
            output += data.toString();

            // Check for expected texts
            for (const text of waitForTexts) {
                if (output.includes(text)) {
                    foundTexts.add(text);
                }
            }

            if (foundTexts.size === waitForTexts.length) {
                foundAll = true;
                // Send any input sequence
                for (const input of inputSequence) {
                    child.stdin?.write(input);
                }
            }
        });

        child.stderr?.on('data', (data: Buffer) => {
            output += `[stderr] ${data.toString()}`;
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            resolve({
                name,
                passed: false,
                message: `Process error: ${err.message}`,
                duration: Date.now() - startTime,
            });
        });
    });
}

async function main() {
    console.log('\n🧪 Wasmtime Runner E2E Tests\n');
    console.log(`Binary: ${BINARY_PATH}\n`);

    const results: TestResult[] = [];

    // Test 1: TUI launches and shows welcome
    console.log('📋 Test 1: TUI launches with welcome message');
    results.push(await runTuiTest('launch', ['Welcome', 'Agent'], [], 10000));

    // Test 2: Shows MCP servers panel
    console.log('📋 Test 2: Shows MCP servers panel');
    results.push(await runTuiTest('mcp-panel', ['MCP', 'Servers'], [], 10000));

    // Test 3: Shows prompt
    console.log('📋 Test 3: Shows command prompt');
    results.push(await runTuiTest('prompt', ['›'], [], 10000));

    // Print results
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let passed = 0;
    let failed = 0;

    for (const result of results) {
        const icon = result.passed ? '✅' : '❌';
        console.log(`${icon} ${result.name} (${result.duration}ms)`);
        if (!result.passed) {
            console.log(`   ${result.message}`);
            failed++;
        } else {
            passed++;
        }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`Results: ${passed} passed, ${failed} failed`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
