/**
 * WebSocket Bridge Implementation for Go WASM modules.
 *
 * This shim implements the host-side of the `ws_bridge` WASM imports
 * defined in stripe-cli-wasm/wasm-bridge/websocket.go. It receives
 * WebSocket operations from Go code running in WASM and translates them
 * to the browser's native WebSocket API.
 *
 * Used primarily by `stripe listen` for real-time webhook event streaming.
 *
 * The Go side uses `//go:wasmimport ws_bridge connect` etc. to call
 * these functions. JCO maps the WASM imports to this module via the
 * --map flag in transpile.mjs.
 */

// ============================================================================
// Connection Management
// ============================================================================

interface WSConnection {
    ws: WebSocket;
    messageQueue: Uint8Array[];
    closed: boolean;
    error: string | null;
    /** Resolve function for blocking reads (JSPI mode) */
    readResolve: ((value: void) => void) | null;
}

let nextHandle = 1;
const connections = new Map<number, WSConnection>();

// Message type constants (must match Go side)
const TEXT_MESSAGE = 1;
const BINARY_MESSAGE = 2;
const CLOSE_MESSAGE = 8;

// ============================================================================
// Exported Host Functions
// ============================================================================

/**
 * Open a WebSocket connection. Returns a handle (0 = failure).
 *
 * Called from Go via: //go:wasmimport ws_bridge connect
 */
export function connect(url: string): number | Promise<number> {
    const handle = nextHandle++;
    const conn: WSConnection = {
        ws: new WebSocket(url),
        messageQueue: [],
        closed: false,
        error: null,
        readResolve: null,
    };

    connections.set(handle, conn);

    // Set up event handlers
    conn.ws.binaryType = 'arraybuffer';

    conn.ws.onmessage = (event: MessageEvent) => {
        const msgType = typeof event.data === 'string' ? TEXT_MESSAGE : BINARY_MESSAGE;
        const payload = typeof event.data === 'string'
            ? new TextEncoder().encode(event.data)
            : new Uint8Array(event.data as ArrayBuffer);

        // Prefix with message type (4 bytes LE)
        const frame = new Uint8Array(4 + payload.length);
        new DataView(frame.buffer).setUint32(0, msgType, true);
        frame.set(payload, 4);

        conn.messageQueue.push(frame);

        // Wake up any blocked read
        if (conn.readResolve) {
            conn.readResolve();
            conn.readResolve = null;
        }
    };

    conn.ws.onclose = () => {
        conn.closed = true;
        // Push a close frame to unblock readers
        const closeFrame = new Uint8Array(4);
        new DataView(closeFrame.buffer).setUint32(0, CLOSE_MESSAGE, true);
        conn.messageQueue.push(closeFrame);

        if (conn.readResolve) {
            conn.readResolve();
            conn.readResolve = null;
        }
    };

    conn.ws.onerror = (event: Event) => {
        conn.error = `WebSocket error: ${event.type}`;
        conn.closed = true;

        if (conn.readResolve) {
            conn.readResolve();
            conn.readResolve = null;
        }
    };

    // Return a promise that resolves when the connection is open
    return new Promise<number>((resolve) => {
        conn.ws.onopen = () => resolve(handle);
        // If connection fails, still return the handle (reads will return EOF)
        conn.ws.onerror = () => {
            conn.closed = true;
            conn.error = 'Connection failed';
            resolve(0); // 0 = failure
        };
    });
}

/**
 * Read the next message from the WebSocket.
 * Returns bytes read (0 = connection closed / no data).
 *
 * In JSPI mode, this suspends until a message is available.
 *
 * Called from Go via: //go:wasmimport ws_bridge read
 */
export function read(handle: number, maxBytes: number): Uint8Array | Promise<Uint8Array> {
    const conn = connections.get(handle);
    if (!conn) {
        return new Uint8Array(0);
    }

    // If we have queued messages, return immediately
    if (conn.messageQueue.length > 0) {
        return dequeueMessage(conn, maxBytes);
    }

    // If closed and no messages, return empty (EOF)
    if (conn.closed) {
        return new Uint8Array(0);
    }

    // In JSPI mode, wait for a message
    return new Promise<Uint8Array>((resolve) => {
        conn.readResolve = () => {
            if (conn.messageQueue.length > 0) {
                resolve(dequeueMessage(conn, maxBytes));
            } else {
                resolve(new Uint8Array(0));
            }
        };
    });
}

function dequeueMessage(conn: WSConnection, maxBytes: number): Uint8Array {
    const frame = conn.messageQueue.shift()!;
    if (frame.length <= maxBytes) {
        return frame;
    }
    // Truncate if needed (shouldn't normally happen with 64KB buffer)
    return frame.slice(0, maxBytes);
}

/**
 * Send a message on the WebSocket. Returns bytes written (0 = failure).
 *
 * Called from Go via: //go:wasmimport ws_bridge write
 */
export function write(handle: number, data: Uint8Array): number {
    const conn = connections.get(handle);
    if (!conn || conn.closed) {
        return 0;
    }

    if (data.length < 4) {
        return 0;
    }

    // Extract message type and payload
    const msgType = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    const payload = data.slice(4);

    try {
        if (msgType === TEXT_MESSAGE) {
            conn.ws.send(new TextDecoder().decode(payload));
        } else {
            conn.ws.send(payload);
        }
        return data.length;
    } catch (err) {
        console.error('[ws-bridge] write error:', err);
        return 0;
    }
}

/**
 * Close the WebSocket connection.
 *
 * Called from Go via: //go:wasmimport ws_bridge close
 */
export function close(handle: number): void {
    const conn = connections.get(handle);
    if (conn) {
        if (!conn.closed) {
            conn.closed = true;
            try {
                conn.ws.close();
            } catch {
                // Ignore close errors
            }
        }
        connections.delete(handle);
    }
}
