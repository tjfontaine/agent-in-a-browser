/**
 * OPFS Async Helper Worker
 * 
 * This worker handles async OPFS operations on behalf of the sandbox worker,
 * allowing the sandbox worker to block synchronously via Atomics.wait() while
 * this worker performs the async OPFS API calls.
 * 
 * Communication happens via SharedArrayBuffer:
 * - Control section (first 64 bytes): flags and lengths
 * - Data section (rest): JSON-encoded requests and responses
 */

export { }; // Make this a module

// Control array layout
const CONTROL = {
    REQUEST_READY: 0,     // Sandbox sets to 1 when request is ready
    RESPONSE_READY: 1,    // Helper sets to 1 when response is ready
    DATA_LENGTH: 2,       // Length of JSON data in dataArray
    SHUTDOWN: 3,          // Set to 1 to terminate the helper loop
};

interface OPFSRequest {
    type: 'scanDirectory' | 'acquireSyncHandle';
    path: string;
}

interface DirectoryEntry {
    name: string;
    kind: 'file' | 'directory';
    size?: number;
    mtime?: number;
}

interface OPFSResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

let opfsRoot: FileSystemDirectoryHandle | null = null;

/**
 * Get directory handle for a path
 */
async function getDirectoryHandle(path: string): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p && p !== '.');
    let dir = opfsRoot;

    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part);
    }

    return dir;
}

/**
 * Scan a directory and return its entries
 */
async function scanDirectory(path: string): Promise<OPFSResponse> {
    try {
        const dir = path === '' || path === '/'
            ? opfsRoot!
            : await getDirectoryHandle(path);

        const entries: DirectoryEntry[] = [];

        for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
            if (handle.kind === 'directory') {
                entries.push({ name, kind: 'directory' });
            } else {
                const fileHandle = handle as FileSystemFileHandle;
                const file = await fileHandle.getFile();
                entries.push({
                    name,
                    kind: 'file',
                    size: file.size,
                    mtime: file.lastModified
                });
            }
        }

        return { success: true, entries };
    } catch (e) {
        console.error('[opfs-helper] scanDirectory error:', path, e);
        return { success: false, error: String(e) };
    }
}

/**
 * Main request processing loop
 */
async function requestLoop(
    controlArray: Int32Array,
    dataArray: Uint8Array
): Promise<void> {
    console.log('[opfs-helper] Starting request loop');

    // Initialize OPFS root
    opfsRoot = await navigator.storage.getDirectory();
    console.log('[opfs-helper] OPFS root acquired');

    while (true) {
        // Wait for request from sandbox worker
        // This blocks until REQUEST_READY becomes non-zero
        const waitResult = Atomics.wait(controlArray, CONTROL.REQUEST_READY, 0);

        if (waitResult === 'not-equal') {
            // Request already pending, process it
        } else if (waitResult === 'timed-out') {
            continue; // Shouldn't happen without timeout
        }

        // Check for shutdown signal
        if (Atomics.load(controlArray, CONTROL.SHUTDOWN) !== 0) {
            console.log('[opfs-helper] Shutdown signal received');
            break;
        }

        // Read request
        const dataLength = Atomics.load(controlArray, CONTROL.DATA_LENGTH);
        const requestJson = new TextDecoder().decode(dataArray.slice(0, dataLength));

        let request: OPFSRequest;
        try {
            request = JSON.parse(requestJson);
        } catch (_e) {
            console.error('[opfs-helper] Failed to parse request:', requestJson);
            request = { type: 'scanDirectory', path: '' };
        }

        // Reset request flag immediately so we can receive next request
        Atomics.store(controlArray, CONTROL.REQUEST_READY, 0);

        console.log('[opfs-helper] Processing request:', request.type, request.path);

        // Process request
        let response: OPFSResponse;

        switch (request.type) {
            case 'scanDirectory':
                response = await scanDirectory(request.path);
                break;
            default:
                response = { success: false, error: `Unknown request type: ${request.type}` };
        }

        // Write response
        const responseJson = JSON.stringify(response);
        const responseBytes = new TextEncoder().encode(responseJson);

        if (responseBytes.length > dataArray.length) {
            console.error('[opfs-helper] Response too large:', responseBytes.length);
            response = { success: false, error: 'Response too large' };
            const truncatedBytes = new TextEncoder().encode(JSON.stringify(response));
            dataArray.set(truncatedBytes);
            Atomics.store(controlArray, CONTROL.DATA_LENGTH, truncatedBytes.length);
        } else {
            dataArray.set(responseBytes);
            Atomics.store(controlArray, CONTROL.DATA_LENGTH, responseBytes.length);
        }

        // Signal response ready and wake up waiting worker
        Atomics.store(controlArray, CONTROL.RESPONSE_READY, 1);
        Atomics.notify(controlArray, CONTROL.RESPONSE_READY);

        console.log('[opfs-helper] Response sent:', response.success);
    }
}

// Handle messages from parent
self.onmessage = async (event: MessageEvent) => {
    const { type, buffer } = event.data;

    if (type === 'init') {
        console.log('[opfs-helper] Initializing with shared buffer');

        const controlArray = new Int32Array(buffer, 0, 16);
        const dataArray = new Uint8Array(buffer, 64);

        // Start the request loop
        requestLoop(controlArray, dataArray).catch(e => {
            console.error('[opfs-helper] Request loop error:', e);
        });

        // Signal ready
        self.postMessage({ type: 'ready' });
    }
};

console.log('[opfs-helper] Worker loaded');
