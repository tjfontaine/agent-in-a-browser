/**
 * Browser TypeScript Runtime - WASI WASM Loader
 *
 * This module loads and initializes the Rust-based TypeScript runtime
 * compiled to wasm32-wasip1 using browser_wasi_shim for WASI support.
 */

import { WASI, File, OpenFile, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

export interface TsRuntime {
    eval(code: string): Promise<string>;
    transpile(code: string): Promise<string>;
    resolve(base: string, specifier: string): Promise<string>;
    dispose(): void;
}

// WASM URL - relative to this file
const WASM_URL = new URL('./browser_ts_runtime.wasm', import.meta.url).href;

let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let wasiInstance: WASI | null = null;
let isInitialized = false;

// Text encoder/decoder for string marshalling
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Read a null-terminated string from WASM memory at the given pointer.
 */
function readCString(ptr: number): string {
    if (!wasmMemory || ptr === 0) return '';

    const mem = new Uint8Array(wasmMemory.buffer);
    let end = ptr;
    while (mem[end] !== 0 && end < mem.length) {
        end++;
    }
    return decoder.decode(mem.slice(ptr, end));
}

/**
 * Write a string to WASM memory and return pointer.
 * Uses malloc from the WASM module.
 */
function writeCString(str: string): number {
    if (!wasmInstance || !wasmMemory) return 0;

    const bytes = encoder.encode(str + '\0');
    const exports = wasmInstance.exports as unknown as WasmExports;

    // Use WASM's memory allocation if available, otherwise use a simple approach
    // For now, we'll write to a fixed buffer area
    // In production, we'd need proper malloc implementation
    const ptr = exports.__heap_base?.value || 0x10000;

    const mem = new Uint8Array(wasmMemory.buffer);
    mem.set(bytes, ptr);

    return ptr;
}

interface WasmExports {
    memory: WebAssembly.Memory;
    __heap_base?: WebAssembly.Global;
    _start: () => void;
    ts_runtime_init: () => number;
    ts_runtime_eval: (codePtr: number) => number;
    ts_runtime_transpile: (codePtr: number) => number;
    ts_runtime_resolve: (basePtr: number, specPtr: number) => number;
    ts_runtime_get_result: () => number;
    ts_runtime_get_error: () => number;
    ts_runtime_free: () => void;
}

/**
 * Initialize the TypeScript runtime with WASI support.
 */
export async function initTsRuntime(): Promise<TsRuntime> {
    if (isInitialized && wasmInstance) {
        return createRuntimeApi();
    }

    console.log('[TsRuntime] Initializing WASI environment...');

    // Create WASI instance with stdio
    const stdin = new OpenFile(new File([]));
    const stdout = ConsoleStdout.lineBuffered((line: string) => {
        console.log('[TsRuntime stdout]:', line);
    });
    const stderr = ConsoleStdout.lineBuffered((line: string) => {
        console.error('[TsRuntime stderr]:', line);
    });

    wasiInstance = new WASI([], ['NODE_ENV=browser'], [stdin, stdout, stderr]);

    console.log('[TsRuntime] Fetching WASM module...');
    const wasmResponse = await fetch(WASM_URL);
    const wasmBytes = await wasmResponse.arrayBuffer();

    console.log('[TsRuntime] Compiling WASM module...');
    const wasmModule = await WebAssembly.compile(wasmBytes);

    console.log('[TsRuntime] Instantiating with WASI imports...');
    wasmInstance = await WebAssembly.instantiate(wasmModule, {
        wasi_snapshot_preview1: wasiInstance.wasiImport,
    });

    // Initialize WASI with the instance (required before calling any WASM functions)
    wasiInstance.initialize(wasmInstance as any);

    const exports = wasmInstance.exports as unknown as WasmExports;
    wasmMemory = exports.memory;

    // Call WASI start if present
    if (exports._start) {
        try {
            exports._start();
        } catch (e) {
            // _start may exit, that's okay for library mode
            console.log('[TsRuntime] _start completed');
        }
    }

    // Initialize the TypeScript runtime
    console.log('[TsRuntime] Calling ts_runtime_init...');
    const initResult = exports.ts_runtime_init();
    if (initResult !== 0) {
        const errorPtr = exports.ts_runtime_get_error();
        const error = readCString(errorPtr);
        throw new Error(`Failed to initialize runtime: ${error}`);
    }

    isInitialized = true;
    console.log('[TsRuntime] Runtime initialized successfully');

    return createRuntimeApi();
}

/**
 * Create the runtime API from the initialized WASM instance.
 */
function createRuntimeApi(): TsRuntime {
    if (!wasmInstance) {
        throw new Error('WASM instance not initialized');
    }
    const exports = wasmInstance.exports as unknown as WasmExports;

    return {
        async eval(code: string): Promise<string> {
            const codePtr = writeCString(code);
            const result = exports.ts_runtime_eval(codePtr);

            if (result !== 0) {
                const errorPtr = exports.ts_runtime_get_error();
                throw new Error(readCString(errorPtr));
            }

            const resultPtr = exports.ts_runtime_get_result();
            return readCString(resultPtr);
        },

        async transpile(code: string): Promise<string> {
            const codePtr = writeCString(code);
            const result = exports.ts_runtime_transpile(codePtr);

            if (result !== 0) {
                const errorPtr = exports.ts_runtime_get_error();
                throw new Error(readCString(errorPtr));
            }

            const resultPtr = exports.ts_runtime_get_result();
            return readCString(resultPtr);
        },

        async resolve(base: string, specifier: string): Promise<string> {
            const basePtr = writeCString(base);
            const specPtr = writeCString(specifier);
            const result = exports.ts_runtime_resolve(basePtr, specPtr);

            if (result !== 0) {
                const errorPtr = exports.ts_runtime_get_error();
                throw new Error(readCString(errorPtr));
            }

            const resultPtr = exports.ts_runtime_get_result();
            return readCString(resultPtr);
        },

        dispose(): void {
            if (exports.ts_runtime_free) {
                exports.ts_runtime_free();
            }
            isInitialized = false;
        },
    };
}

/**
 * Get the initialized runtime, or initialize it if needed.
 */
export async function getTsRuntime(): Promise<TsRuntime> {
    return initTsRuntime();
}
