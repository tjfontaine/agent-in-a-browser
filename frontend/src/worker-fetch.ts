
export interface WorkerFetch {
    (input: string, init?: RequestInit): Promise<Response>;
}

export function createWorkerFetch(worker: Worker): WorkerFetch {
    return async (input: string, init?: RequestInit): Promise<Response> => {
        console.log('[WorkerFetch] Starting fetch:', input, init?.method || 'GET');
        const { port1, port2 } = new MessageChannel();
        const signal = init?.signal;

        if (signal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }

        return new Promise<Response>((resolve, reject) => {
            const cleanup = () => {
                port1.close();
                signal?.removeEventListener('abort', onAbort);
            };

            const onAbort = () => {
                // Send abort signal to worker
                // Note: We might need a separate mechanism if we want to support true cancellation
                // But for now, we just close the channel and reject locally
                cleanup();
                reject(new DOMException('Aborted', 'AbortError'));
            };

            signal?.addEventListener('abort', onAbort);

            port1.onmessage = (event) => {
                const { type, payload } = event.data;

                if (type === 'head') {
                    // Response headers received
                    console.log('[WorkerFetch] Received head:', payload);
                    const { status, statusText, headers } = payload;

                    // Create a ReadableStream that will receive chunks from the port
                    const stream = new ReadableStream({
                        start(controller) {
                            port1.onmessage = (chunkEvent) => {
                                const chunkType = chunkEvent.data.type;
                                if (chunkType === 'chunk') {
                                    controller.enqueue(chunkEvent.data.chunk);
                                } else if (chunkType === 'end') {
                                    controller.close();
                                    cleanup();
                                } else if (chunkType === 'error') {
                                    controller.error(new Error(chunkEvent.data.error));
                                    cleanup();
                                }
                            };
                        },
                        cancel() {
                            cleanup();
                        }
                    });

                    resolve(new Response(stream, {
                        status,
                        statusText,
                        headers: new Headers(headers)
                    }));
                } else if (type === 'error') {
                    console.error('[WorkerFetch] Error from worker:', payload);
                    cleanup();
                    reject(new Error(payload.error));
                }
            };

            console.log('[WorkerFetch] Posting to worker');
            worker.postMessage({
                type: 'fetch',
                url: input.toString(),
                method: init?.method || 'GET',
                headers: init?.headers || {},
                body: init?.body
            }, [port2]);
        });
    };
}
