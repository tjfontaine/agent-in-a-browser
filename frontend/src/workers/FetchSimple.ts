/**
 * Safari-compatible worker fetch using request IDs instead of MessageChannel ports.
 * Safari has known issues with transferring MessagePort objects to workers.
 */

export interface WorkerFetchSimple {
    (input: string, init?: RequestInit): Promise<Response>;
}

// Request ID counter
let requestIdCounter = 0;

// Pending requests map
const pendingRequests = new Map<string, {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
}>();

/**
 * Create a Safari-compatible fetch function that communicates with a worker
 * using simple postMessage without MessageChannel port transfer.
 */
export function createWorkerFetchSimple(worker: Worker): WorkerFetchSimple {
    // Set up message handler for responses
    worker.addEventListener('message', (event) => {
        console.log('[WorkerFetchSimple] Received message:', event.data.type, event.data.requestId);
        const { type, requestId, payload } = event.data;

        if (type === 'fetch-response' && requestId) {
            const pending = pendingRequests.get(requestId);
            if (pending) {
                pendingRequests.delete(requestId);

                if (payload.error) {
                    pending.reject(new Error(payload.error));
                } else {
                    // Create Response from payload
                    const body = new Uint8Array(payload.body);
                    const response = new Response(body, {
                        status: payload.status,
                        statusText: payload.statusText || 'OK',
                        headers: new Headers(payload.headers || [])
                    });
                    pending.resolve(response);
                }
            }
        }
    });

    return async (input: string, init?: RequestInit): Promise<Response> => {
        console.log('[WorkerFetchSimple] Starting fetch:', input, init?.method || 'GET');

        const signal = init?.signal;
        if (signal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }

        const requestId = `req-${++requestIdCounter}-${Date.now()}`;

        return new Promise<Response>((resolve, reject) => {
            const cleanup = () => {
                pendingRequests.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
            };

            const onAbort = () => {
                cleanup();
                reject(new DOMException('Aborted', 'AbortError'));
            };

            signal?.addEventListener('abort', onAbort);

            // Store pending request
            pendingRequests.set(requestId, {
                resolve: (response) => {
                    cleanup();
                    resolve(response);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                }
            });

            // Convert body to array if needed (for transfer)
            let bodyArray: number[] | null = null;
            if (init?.body) {
                if (init.body instanceof Blob) {
                    // Handle Blob asynchronously
                    const blob = init.body;
                    (async () => {
                        const buffer = await blob.arrayBuffer();
                        bodyArray = Array.from(new Uint8Array(buffer));
                        postRequest();
                    })();
                    return;
                } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
                    bodyArray = Array.from(new Uint8Array(
                        init.body instanceof ArrayBuffer ? init.body : init.body.buffer
                    ));
                } else if (typeof init.body === 'string') {
                    bodyArray = Array.from(new TextEncoder().encode(init.body));
                }
            }

            function postRequest() {
                console.log('[WorkerFetchSimple] Posting to worker with requestId:', requestId);
                worker.postMessage({
                    type: 'fetch-simple',
                    requestId,
                    url: input.toString(),
                    method: init?.method || 'GET',
                    headers: init?.headers || {},
                    body: bodyArray
                });
                // No transferables - Safari-safe!
            }

            postRequest();
        });
    };
}
