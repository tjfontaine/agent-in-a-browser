/**
 * Execution Mode Detection
 * 
 * Single source of truth for JSPI detection and execution mode.
 * This module should be imported by all code that needs to branch
 * on browser capabilities.
 * 
 * JSPI (JavaScript Promise Integration) allows WASM to suspend/resume
 * on async operations like blocking reads. Without JSPI, we use a
 * Worker-based architecture with SharedArrayBuffer + Atomics.wait blocking.
 * 
 * Execution Modes:
 * - 'jspi': Chrome with JSPI enabled - async suspension works, true lazy loading
 * - 'sync-worker': Safari/Firefox in a Web Worker - uses Atomics.wait for blocking
 * - 'sync-main': Safari/Firefox in main thread (limited, mostly for sandbox)
 */

// JSPI feature detection
// WebAssembly.Suspending is not yet in TypeScript's lib.dom.d.ts
const webAssembly = WebAssembly as typeof WebAssembly & { Suspending?: unknown };

/**
 * Whether the browser supports JSPI (JavaScript Promise Integration).
 * True for Chrome with flags, false for Safari/Firefox.
 */
// export const hasJSPI: boolean = typeof webAssembly.Suspending !== 'undefined';
export const hasJSPI: boolean = typeof webAssembly.Suspending !== 'undefined';

/**
 * Execution mode type - determines which code paths to use.
 */
export type ExecutionMode =
    | 'jspi'        // Chrome: Full async suspension works
    | 'sync-worker' // Safari Worker: Uses Atomics.wait blocking
    | 'sync-main';  // Safari Main: Limited, sandbox context

// Detect worker context without relying solely on duck-typing
// WorkerGlobalScope is defined in workers but not in main thread
declare const WorkerGlobalScope: { new(): WorkerGlobalScope } | undefined;
interface WorkerGlobalScope { readonly self: WorkerGlobalScope }

const isWorkerContext =
    typeof WorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    self instanceof WorkerGlobalScope;

/**
 * Current execution mode - initialized based on environment detection.
 * Can be updated if the context changes (e.g., when WorkerBridge starts).
 */
let _currentMode: ExecutionMode = hasJSPI
    ? 'jspi'
    : (isWorkerContext ? 'sync-worker' : 'sync-main');

/**
 * Get the current execution mode.
 */
export function getExecutionMode(): ExecutionMode {
    return _currentMode;
}

/**
 * Set the execution mode explicitly.
 * Useful when context changes (e.g., initializing a worker).
 */
export function setExecutionMode(mode: ExecutionMode): void {
    console.log(`[ExecutionMode] Mode changed: ${_currentMode} -> ${mode}`);
    _currentMode = mode;
}

/**
 * Check if currently in a sync mode (worker or main).
 * Useful for guards that need to behave differently without JSPI.
 */
export function isSyncMode(): boolean {
    return _currentMode === 'sync-worker' || _currentMode === 'sync-main';
}

/**
 * Check if currently in worker sync mode (where Atomics.wait works).
 */
export function isSyncWorkerMode(): boolean {
    return _currentMode === 'sync-worker';
}

/**
 * Convenience re-export: true if async suspension is available.
 * Equivalent to `hasJSPI`, but reads from the initialized constant.
 */
export function canSuspendAsync(): boolean {
    return hasJSPI;
}

/**
 * Check if the current context is cross-origin isolated.
 * Required for SharedArrayBuffer to be available.
 */
export function isCrossOriginIsolated(): boolean {
    return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
}

// Log at startup with full context
console.log(`[ExecutionMode] JSPI: ${hasJSPI ? 'YES' : 'NO'}, Mode: ${_currentMode}, CrossOriginIsolated: ${isCrossOriginIsolated() ? 'YES' : 'NO'}`);
