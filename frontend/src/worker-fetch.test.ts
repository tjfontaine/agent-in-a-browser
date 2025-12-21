/**
 * Tests for WorkerFetch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkerFetch, type WorkerFetch } from './worker-fetch';

// Mock MessageChannel
class MockMessagePort {
    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;

    close() {
        this.closed = true;
    }

    postMessage() { }
}

function createMockMessageChannel() {
    const port1 = new MockMessagePort();
    const port2 = new MockMessagePort();
    return { port1, port2 };
}

describe('WorkerFetch', () => {
    let mockWorker: { postMessage: ReturnType<typeof vi.fn> };
    let mockChannel: ReturnType<typeof createMockMessageChannel>;
    let workerFetch: WorkerFetch;

    beforeEach(() => {
        mockWorker = {
            postMessage: vi.fn(),
        };
        mockChannel = createMockMessageChannel();

        // Mock global MessageChannel
        vi.stubGlobal('MessageChannel', function (this: { port1: MockMessagePort; port2: MockMessagePort }) {
            this.port1 = mockChannel.port1;
            this.port2 = mockChannel.port2;
        });

        workerFetch = createWorkerFetch(mockWorker as unknown as Worker);
    });

    describe('createWorkerFetch', () => {
        it('should return a function', () => {
            expect(typeof workerFetch).toBe('function');
        });
    });

    describe('fetch request', () => {
        it('should post message to worker with URL', async () => {
            const promise = workerFetch('http://api.example.com/data');

            expect(mockWorker.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'fetch',
                    url: 'http://api.example.com/data',
                    method: 'GET',
                }),
                expect.any(Array)
            );

            // Clean up promise - send success to avoid unhandled rejection
            mockChannel.port1.onmessage?.({
                data: {
                    type: 'head',
                    payload: { status: 200, statusText: 'OK', headers: {} }
                }
            } as MessageEvent);
            await promise;
        });

        it('should use POST method when specified', () => {
            workerFetch('http://api.example.com', { method: 'POST' });

            expect(mockWorker.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'POST',
                }),
                expect.any(Array)
            );
        });

        it('should include body in request', () => {
            const body = JSON.stringify({ key: 'value' });
            workerFetch('http://api.example.com', { method: 'POST', body });

            expect(mockWorker.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    body,
                }),
                expect.any(Array)
            );
        });
    });

    describe('abort handling', () => {
        it('should reject immediately if signal already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                workerFetch('http://api.example.com', { signal: controller.signal })
            ).rejects.toThrow('Aborted');
        });
    });

    describe('response handling', () => {
        it('should resolve with Response when head received', async () => {
            const fetchPromise = workerFetch('http://api.example.com');

            // Simulate head response
            mockChannel.port1.onmessage?.({
                data: {
                    type: 'head',
                    payload: {
                        status: 200,
                        statusText: 'OK',
                        headers: { 'content-type': 'application/json' }
                    }
                }
            } as MessageEvent);

            const response = await fetchPromise;
            expect(response.status).toBe(200);
            expect(response.statusText).toBe('OK');
        });

        it('should reject on error response', async () => {
            const fetchPromise = workerFetch('http://api.example.com');

            // Simulate error
            mockChannel.port1.onmessage?.({
                data: {
                    type: 'error',
                    payload: { error: 'Network error' }
                }
            } as MessageEvent);

            await expect(fetchPromise).rejects.toThrow('Network error');
        });
    });
});
