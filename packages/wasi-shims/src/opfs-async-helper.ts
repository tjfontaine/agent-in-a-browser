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
    type: 'scanDirectory' | 'readFile' | 'writeFile' | 'readFileBinary' | 'writeFileBinary' | 'exists' | 'stat' | 'mkdir' | 'rmdir' | 'unlink';
    path: string;
    data?: string;         // For writeFile (text)
    recursive?: boolean;   // For mkdir/rmdir
    binaryOffset?: number; // For writeFileBinary: where binary data starts in dataArray
    binaryLength?: number; // For writeFileBinary: length of binary data
}

interface DirectoryEntry {
    name: string;
    kind: 'file' | 'directory';
    size?: number;
    mtime?: number;
}

interface OPFSResponse {
    success: boolean;
    entries?: DirectoryEntry[];  // For scanDirectory
    data?: string;               // For readFile (text)
    size?: number;               // For stat and readFileBinary
    mtime?: number;              // For stat
    isFile?: boolean;            // For stat
    isDirectory?: boolean;       // For stat
    error?: string;
    binaryOffset?: number;       // For readFileBinary: where binary data starts in dataArray
    binaryLength?: number;       // For readFileBinary: length of binary data
}

let opfsRoot: FileSystemDirectoryHandle | null = null;

/**
 * Get directory handle for a path
 */
async function getDirectoryHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p && p !== '.');
    let dir = opfsRoot;

    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create });
    }

    return dir;
}

/**
 * Get file handle for a path
 */
async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    if (!opfsRoot) throw new Error('OPFS not initialized');

    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.length === 0) throw new Error('Invalid path');

    const fileName = parts.pop()!;
    const dir = parts.length > 0
        ? await getDirectoryHandle(parts.join('/'), create)
        : opfsRoot;

    return await dir.getFileHandle(fileName, { create });
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
 * Read file contents as text
 */
async function readFile(path: string): Promise<OPFSResponse> {
    try {
        const fileHandle = await getFileHandle(path);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return { success: true, data: text };
    } catch (_e) {
        return { success: false, error: `ENOENT: no such file: ${path}` };
    }

}

/**
 * Write data to a file
 */
async function writeFile(path: string, data: string): Promise<OPFSResponse> {
    try {
        const fileHandle = await getFileHandle(path, true);
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Read file contents as binary (returns data via dataArray, not JSON)
 * The binary data is written to dataArray starting at a fixed offset,
 * and the response includes binaryOffset and binaryLength.
 */
async function readFileBinary(path: string, dataArray: Uint8Array): Promise<OPFSResponse> {
    try {
        const fileHandle = await getFileHandle(path);
        const file = await fileHandle.getFile();
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Reserve first 1KB for JSON response, put binary after
        const binaryOffset = 1024;
        const maxBinarySize = dataArray.length - binaryOffset;

        if (bytes.length > maxBinarySize) {
            return { success: false, error: `File too large: ${bytes.length} > ${maxBinarySize}` };
        }

        // Copy binary data to dataArray
        dataArray.set(bytes, binaryOffset);

        return {
            success: true,
            binaryOffset,
            binaryLength: bytes.length,
            size: bytes.length
        };
    } catch (_e) {
        return { success: false, error: `ENOENT: no such file: ${path}` };
    }
}

/**
 * Write binary data to a file (reads data from dataArray, not JSON)
 * The binary data is read from dataArray using binaryOffset and binaryLength.
 */
async function writeFileBinary(
    path: string,
    dataArray: Uint8Array,
    binaryOffset: number,
    binaryLength: number
): Promise<OPFSResponse> {
    try {
        // Extract binary data from dataArray
        const binaryData = dataArray.slice(binaryOffset, binaryOffset + binaryLength);

        const fileHandle = await getFileHandle(path, true);
        const writable = await fileHandle.createWritable();
        await writable.write(binaryData);
        await writable.close();
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Check if a path exists
 */
async function exists(path: string): Promise<OPFSResponse> {
    try {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) {
            // Root always exists
            return { success: true };
        }

        // Try as file first
        try {
            await getFileHandle(path);
            return { success: true };
        } catch {
            // Try as directory
            await getDirectoryHandle(path);
            return { success: true };
        }
    } catch {
        return { success: false };
    }
}

/**
 * Get file/directory stats
 */
async function stat(path: string): Promise<OPFSResponse> {
    try {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) {
            // Root directory
            return { success: true, isDirectory: true, isFile: false, size: 0 };
        }

        // Try as file first
        try {
            const fileHandle = await getFileHandle(path);
            const file = await fileHandle.getFile();
            return {
                success: true,
                isDirectory: false,
                isFile: true,
                size: file.size,
                mtime: file.lastModified
            };
        } catch {
            // Try as directory
            await getDirectoryHandle(path);
            return { success: true, isDirectory: true, isFile: false, size: 0 };
        }
    } catch {
        return { success: false, error: 'ENOENT' };
    }
}

/**
 * Create a directory
 */
async function mkdir(path: string, recursive: boolean): Promise<OPFSResponse> {
    try {
        if (recursive) {
            await getDirectoryHandle(path, true);
        } else {
            const parts = path.split('/').filter(p => p && p !== '.');
            if (parts.length === 0) throw new Error('Invalid path');
            const dirName = parts.pop()!;
            const parent = parts.length > 0 ? await getDirectoryHandle(parts.join('/')) : opfsRoot!;
            await parent.getDirectoryHandle(dirName, { create: true });
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Remove a directory
 */
async function rmdir(path: string, recursive: boolean): Promise<OPFSResponse> {
    try {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) throw new Error('Cannot remove root');
        const dirName = parts.pop()!;
        const parent = parts.length > 0 ? await getDirectoryHandle(parts.join('/')) : opfsRoot!;
        await parent.removeEntry(dirName, { recursive });
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/**
 * Remove a file
 */
async function unlink(path: string): Promise<OPFSResponse> {
    try {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) throw new Error('Invalid path');
        const fileName = parts.pop()!;
        const parent = parts.length > 0 ? await getDirectoryHandle(parts.join('/')) : opfsRoot!;
        await parent.removeEntry(fileName);
        return { success: true };
    } catch (e) {
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

    // OPFS root is already initialized before this function is called

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
            case 'readFile':
                response = await readFile(request.path);
                break;
            case 'writeFile':
                response = await writeFile(request.path, request.data || '');
                break;
            case 'readFileBinary':
                response = await readFileBinary(request.path, dataArray);
                break;
            case 'writeFileBinary':
                response = await writeFileBinary(
                    request.path,
                    dataArray,
                    request.binaryOffset || 0,
                    request.binaryLength || 0
                );
                break;
            case 'exists':
                response = await exists(request.path);
                break;
            case 'stat':
                response = await stat(request.path);
                break;
            case 'mkdir':
                response = await mkdir(request.path, request.recursive || false);
                break;
            case 'rmdir':
                response = await rmdir(request.path, request.recursive || false);
                break;
            case 'unlink':
                response = await unlink(request.path);
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

        // Initialize OPFS root BEFORE signaling ready
        try {
            console.log('[opfs-helper] Acquiring OPFS root...');
            opfsRoot = await navigator.storage.getDirectory();
            console.log('[opfs-helper] OPFS root acquired');

            // Signal ready only after OPFS is successfully initialized
            self.postMessage({ type: 'ready' });

            // Start the request loop (this runs indefinitely)
            await requestLoop(controlArray, dataArray);
        } catch (e) {
            console.error('[opfs-helper] Initialization error:', e);
            // Signal error back to parent
            self.postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) });
        }
    }
};

console.log('[opfs-helper] Worker loaded');
