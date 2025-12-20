// Wasmer SDK Bash Shell Worker
// Runs real Bash shell in browser via WASI/WASIX

import { init, Wasmer, Directory } from "@wasmer/sdk";
// Use inline wasm to avoid loading issues
import wasmerModule from "@wasmer/sdk/wasm?url";

let bashPkg: Awaited<ReturnType<typeof Wasmer.fromRegistry>> | null = null;
let workDir: Directory | null = null;

// Initialize Wasmer SDK and load Bash
async function initialize() {
    self.postMessage({ type: 'status', message: 'Initializing Wasmer SDK...' });

    try {
        // Initialize with explicit module URL
        await init({ module: wasmerModule });

        self.postMessage({ type: 'status', message: 'Loading Bash from registry...' });

        // Load Bash package from Wasmer registry
        bashPkg = await Wasmer.fromRegistry("sharrattj/bash");

        // Create a persistent working directory for the session
        workDir = new Directory();

        self.postMessage({ type: 'ready' });
    } catch (error: any) {
        console.error('Wasmer init error:', error);
        self.postMessage({ type: 'error', message: `Init failed: ${error.message}` });
    }
}

// Execute a shell command
async function executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!bashPkg || !workDir) {
        throw new Error('Shell not initialized');
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

// Worker message handler
self.onmessage = async (event: MessageEvent) => {
    const { type, id, command } = event.data;

    if (type === 'execute') {
        try {
            const result = await executeCommand(command);
            const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '');
            self.postMessage({ type: 'result', id, output: output.trim(), exitCode: result.exitCode });
        } catch (error: any) {
            self.postMessage({ type: 'result', id, output: `Error: ${error.message}`, exitCode: 1 });
        }
    }
};

// Start initialization
initialize();
