/**
 * Unit tests for the Go CLI adapter pattern.
 *
 * Tests the createGoCliAdapter function which wraps a Go WASI CLI component
 * (exporting wasi:cli/run) to match the shell:unix/command interface expected
 * by the lazy module system.
 *
 * These tests use mocked modules to verify:
 * - CLI shims are configured correctly before run()
 * - CLI shims are cleaned up after run() completes
 * - Exit codes are extracted from ComponentExit errors
 * - stdout/stderr are routed through piped streams
 * - Both success and error paths work correctly
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

// Mock types matching the adapter's expectations
interface MockCliShim {
    setArguments: MockFn;
    setEnvironment: MockFn;
    setInitialCwd: MockFn;
    clearCliConfig: MockFn;
    setPipedStreams: MockFn;
    clearPipedStreams: MockFn;
}

interface MockOutputStream {
    write: MockFn;
}

interface MockInputStream {
    read: MockFn;
}

// Replicate the ComponentExit error from ghostty-cli-shim
class ComponentExit extends Error {
    exitError = true;
    code: number;
    constructor(code: number) {
        super(`Component exited ${code === 0 ? 'successfully' : 'with error'}`);
        this.code = code;
    }
}

/**
 * Minimal reimplementation of createGoCliAdapter for unit testing.
 * This mirrors the production code in lazy-modules.ts without requiring
 * the full WASM module loading infrastructure.
 */
function createGoCliAdapter(
    goModule: { run: () => void | Promise<void> },
    cliShim: MockCliShim,
) {
    return {
        spawn(
            name: string,
            args: string[],
            env: { cwd: string; vars: [string, string][] },
            _stdin: MockInputStream,
            stdout: MockOutputStream,
            stderr: MockOutputStream,
        ) {
            cliShim.setArguments([name, ...args]);
            cliShim.setEnvironment(env.vars);
            cliShim.setInitialCwd(env.cwd);
            cliShim.setPipedStreams(
                (contents: Uint8Array) => {
                    stdout.write(contents);
                    return BigInt(contents.length);
                },
                (contents: Uint8Array) => {
                    stderr.write(contents);
                    return BigInt(contents.length);
                },
            );

            let exitCode: number | undefined;

            const cleanup = () => {
                cliShim.clearPipedStreams();
                cliShim.clearCliConfig();
            };

            const extractExitCode = (err: unknown): number => {
                if (err && typeof err === 'object' && 'exitError' in err) {
                    return (err as { code?: number }).code ?? 1;
                }
                return 1;
            };

            const executionPromise = (async () => {
                try {
                    await goModule.run();
                    exitCode = 0;
                    return 0;
                } catch (err: unknown) {
                    exitCode = extractExitCode(err);
                    return exitCode;
                } finally {
                    cleanup();
                }
            })();

            return {
                poll: () => exitCode,
                resolve: () => executionPromise,
            };
        },
        listCommands: () => ['stripe'],
    };
}

describe('createGoCliAdapter', () => {
    let cliShim: MockCliShim;
    let stdout: MockOutputStream;
    let stderr: MockOutputStream;
    let stdin: MockInputStream;

    beforeEach(() => {
        cliShim = {
            setArguments: vi.fn(),
            setEnvironment: vi.fn(),
            setInitialCwd: vi.fn(),
            clearCliConfig: vi.fn(),
            setPipedStreams: vi.fn(),
            clearPipedStreams: vi.fn(),
        };
        stdout = { write: vi.fn() };
        stderr = { write: vi.fn() };
        stdin = { read: vi.fn() };
    });

    it('configures CLI shims with args, env, and cwd before calling run()', async () => {
        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['--help'],
            { cwd: '/home/user', vars: [['STRIPE_API_KEY', 'sk_test_123']] },
            stdin, stdout, stderr,
        );

        await handle.resolve();

        expect(cliShim.setArguments).toHaveBeenCalledWith(['stripe', '--help']);
        expect(cliShim.setEnvironment).toHaveBeenCalledWith([['STRIPE_API_KEY', 'sk_test_123']]);
        expect(cliShim.setInitialCwd).toHaveBeenCalledWith('/home/user');
        expect(cliShim.setPipedStreams).toHaveBeenCalledWith(
            expect.any(Function),
            expect.any(Function),
        );
    });

    it('cleans up CLI shims after successful run()', async () => {
        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['version'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        await handle.resolve();

        expect(cliShim.clearPipedStreams).toHaveBeenCalled();
        expect(cliShim.clearCliConfig).toHaveBeenCalled();
    });

    it('returns exit code 0 on successful run()', async () => {
        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['version'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        const code = await handle.resolve();
        expect(code).toBe(0);
        expect(handle.poll()).toBe(0);
    });

    it('extracts exit code from ComponentExit error (exit 0)', async () => {
        const goModule = {
            run: vi.fn(() => { throw new ComponentExit(0); }),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['--help'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        const code = await handle.resolve();
        expect(code).toBe(0);
    });

    it('extracts exit code from ComponentExit error (exit 1)', async () => {
        const goModule = {
            run: vi.fn(() => { throw new ComponentExit(1); }),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['bad-command'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        const code = await handle.resolve();
        expect(code).toBe(1);
    });

    it('cleans up CLI shims even when run() throws', async () => {
        const goModule = {
            run: vi.fn(() => { throw new ComponentExit(1); }),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', [],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        await handle.resolve();

        expect(cliShim.clearPipedStreams).toHaveBeenCalled();
        expect(cliShim.clearCliConfig).toHaveBeenCalled();
    });

    it('returns exit code 1 for non-ComponentExit errors', async () => {
        const goModule = {
            run: vi.fn(() => { throw new Error('WASM memory overflow'); }),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', [],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        const code = await handle.resolve();
        expect(code).toBe(1);
    });

    it('handles async run() that resolves (JSPI mode)', async () => {
        const goModule = {
            run: vi.fn(() => Promise.resolve()),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', ['version'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        // poll() may be undefined before resolution
        const code = await handle.resolve();
        expect(code).toBe(0);
        expect(handle.poll()).toBe(0);
    });

    it('handles async run() that rejects with ComponentExit', async () => {
        const goModule = {
            run: vi.fn(() => Promise.reject(new ComponentExit(2))),
        };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', [],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        const code = await handle.resolve();
        expect(code).toBe(2);
        expect(cliShim.clearPipedStreams).toHaveBeenCalled();
    });

    it('routes stdout through piped streams', async () => {
        // Capture the stdoutWrite callback passed to setPipedStreams
        let capturedStdoutWrite: ((contents: Uint8Array) => bigint) | null = null;
        cliShim.setPipedStreams.mockImplementation((stdoutWrite: (contents: Uint8Array) => bigint) => {
            capturedStdoutWrite = stdoutWrite;
        });

        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);

        adapter.spawn(
            'stripe', ['--help'],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        // Simulate the Go component writing to stdout via the piped stream
        expect(capturedStdoutWrite).not.toBeNull();
        const data = new TextEncoder().encode('stripe version 1.0');
        const bytesWritten = capturedStdoutWrite!(data);
        expect(bytesWritten).toBe(BigInt(data.length));
        expect(stdout.write).toHaveBeenCalledWith(data);
    });

    it('listCommands returns stripe', () => {
        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);
        expect(adapter.listCommands()).toEqual(['stripe']);
    });

    it('passes empty args list correctly', async () => {
        const goModule = { run: vi.fn() };
        const adapter = createGoCliAdapter(goModule, cliShim);

        const handle = adapter.spawn(
            'stripe', [],
            { cwd: '/', vars: [] },
            stdin, stdout, stderr,
        );

        await handle.resolve();
        expect(cliShim.setArguments).toHaveBeenCalledWith(['stripe']);
    });
});
