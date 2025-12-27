/**
 * Module Loader Worker
 * 
 * Handles async module loading in a worker thread.
 * Main thread blocks via Atomics.wait() until loading completes.
 */

/// <reference lib="webworker" />

// Control array layout
const CONTROL = {
    REQUEST_READY: 0,
    RESPONSE_READY: 1,
    MODULE_LOADED: 2,  // 1 = loaded, 0 = not loaded, -1 = error
    SHUTDOWN: 3,
};

let controlArray: Int32Array | null = null;

// Cache for loaded modules
const loadedModules = new Map<string, unknown>();
const loadingPromises = new Map<string, Promise<unknown>>();

/**
 * Initialize with shared buffer from main thread
 */
self.onmessage = async (e: MessageEvent) => {
    const { type, buffer, moduleName, modulePath } = e.data;

    if (type === 'init') {
        controlArray = new Int32Array(buffer, 0, 16);
        self.postMessage({ type: 'ready' });
    } else if (type === 'loadModule') {
        await handleLoadModule(moduleName, modulePath);
    }
};

/**
 * Load a module asynchronously
 */
async function handleLoadModule(moduleName: string, modulePath: string): Promise<void> {
    if (!controlArray) {
        self.postMessage({ type: 'error', error: 'Worker not initialized' });
        return;
    }

    try {
        console.log(`[ModuleLoaderWorker] Loading ${moduleName} from ${modulePath}`);

        // Check if already loaded
        if (loadedModules.has(moduleName)) {
            Atomics.store(controlArray, CONTROL.MODULE_LOADED, 1);
            Atomics.notify(controlArray, CONTROL.RESPONSE_READY);
            self.postMessage({ type: 'moduleLoaded', moduleName, success: true });
            return;
        }

        // Check if currently loading
        let loadPromise = loadingPromises.get(moduleName);
        if (!loadPromise) {
            // Start loading
            loadPromise = import(/* @vite-ignore */ modulePath);
            loadingPromises.set(moduleName, loadPromise);
        }

        const module = await loadPromise;
        loadedModules.set(moduleName, module);
        loadingPromises.delete(moduleName);

        console.log(`[ModuleLoaderWorker] ${moduleName} loaded successfully`);

        // Signal success
        Atomics.store(controlArray, CONTROL.MODULE_LOADED, 1);
        Atomics.store(controlArray, CONTROL.RESPONSE_READY, 1);
        Atomics.notify(controlArray, CONTROL.RESPONSE_READY);

        self.postMessage({ type: 'moduleLoaded', moduleName, success: true });

    } catch (error) {
        console.error(`[ModuleLoaderWorker] Failed to load ${moduleName}:`, error);
        loadingPromises.delete(moduleName);

        // Signal error
        Atomics.store(controlArray, CONTROL.MODULE_LOADED, -1);
        Atomics.store(controlArray, CONTROL.RESPONSE_READY, 1);
        Atomics.notify(controlArray, CONTROL.RESPONSE_READY);

        self.postMessage({
            type: 'moduleLoaded',
            moduleName,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

export { };
