// Wasmer SDK Shell Worker
// Load bash and python packages separately from registry

import { init, Wasmer, Directory } from "@wasmer/sdk";
import wasmerModule from "@wasmer/sdk/wasm?url";

let bashPkg: Awaited<ReturnType<typeof Wasmer.fromRegistry>> | null = null;
let pythonPkg: Awaited<ReturnType<typeof Wasmer.fromRegistry>> | null = null;
let workDir: Directory | null = null;

// Initialize Wasmer SDK and load packages
async function initialize() {
    self.postMessage({ type: 'status', message: 'Initializing Wasmer SDK...' });

    try {
        await init({ module: wasmerModule });

        // Create a persistent working directory for the session
        workDir = new Directory();

        self.postMessage({ type: 'status', message: 'Loading Bash...' });
        bashPkg = await Wasmer.fromRegistry("sharrattj/bash");

        self.postMessage({ type: 'status', message: 'Loading Python...' });
        pythonPkg = await Wasmer.fromRegistry("python/python");

        self.postMessage({ type: 'ready' });
    } catch (error: any) {
        console.error('Wasmer init error:', error);
        self.postMessage({ type: 'error', message: `Init failed: ${error.message}` });
    }
}

// Execute a shell command using bash
async function executeShellCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!bashPkg || !workDir) {
        throw new Error('Bash not initialized');
    }

    try {
        const instance = await bashPkg.entrypoint!.run({
            args: ["-c", command],
            mount: { "/workspace": workDir },
            cwd: "/workspace",
        });

        const result = await instance.wait();

        return {
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: result.code,
        };
    } catch (error: any) {
        return {
            stdout: '',
            stderr: error.message || 'Unknown error',
            exitCode: 1,
        };
    }
}

// Execute Python code
async function executePythonCommand(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!pythonPkg || !workDir) {
        throw new Error('Python not initialized');
    }

    try {
        const instance = await pythonPkg.entrypoint!.run({
            args: ["-c", code],
            mount: { "/workspace": workDir },
            cwd: "/workspace",
        });

        const result = await instance.wait();

        return {
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: result.code,
        };
    } catch (error: any) {
        return {
            stdout: '',
            stderr: error.message || 'Unknown error',
            exitCode: 1,
        };
    }
}

// Worker message handler
self.onmessage = async (event: MessageEvent) => {
    const { type, id, command, tool } = event.data;

    if (type === 'execute') {
        try {
            let result;
            if (tool === 'python') {
                result = await executePythonCommand(command);
            } else {
                result = await executeShellCommand(command);
            }
            const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '');
            self.postMessage({ type: 'result', id, output: output.trim(), exitCode: result.exitCode });
        } catch (error: any) {
            self.postMessage({ type: 'result', id, output: `Error: ${error.message}`, exitCode: 1 });
        }
    }
};

// Start initialization
initialize();
