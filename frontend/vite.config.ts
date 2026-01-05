import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig(({ mode }) => ({
    // Custom domain: agent.edge-agent.dev (no subpath needed)
    base: '/',
    plugins: [
        // Polyfill Node.js core modules for browser compatibility
        nodePolyfills({
            // Include specific polyfills needed for WASM modules
            include: ['buffer', 'process', 'stream', 'events'],
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
        }),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            // Package resolution for monorepo
            '@tjfontaine/mcp-wasm-server': path.resolve(__dirname, '../packages/mcp-wasm-server'),
            '@tjfontaine/wasi-shims': path.resolve(__dirname, '../packages/wasi-shims/src'),
            '@tjfontaine/wasm-loader': path.resolve(__dirname, '../packages/wasm-loader/dist'),
            '@tjfontaine/wasm-vim': path.resolve(__dirname, '../packages/wasm-vim'),
            // Enable packages outside frontend to resolve node polyfills
            'vite-plugin-node-polyfills/shims/buffer': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/buffer'),
            'vite-plugin-node-polyfills/shims/global': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/global'),
            'vite-plugin-node-polyfills/shims/process': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/process'),
        },
        // Dedupe shims to prevent multiple bundle copies (fixes instanceof checks and resource isolation)
        dedupe: [
            // Our WASI shims - critical for resource isolation between worker and transpiled modules
            '@tjfontaine/wasi-shims',
            // preview2-shim for bytecode alliance components
            '@bytecodealliance/preview2-shim',
            '@bytecodealliance/preview2-shim/io',
            '@bytecodealliance/preview2-shim/cli',
            '@bytecodealliance/preview2-shim/random',
        ],
    },
    server: {
        port: 3000,
        headers: {
            // Required for SharedArrayBuffer (needed for OPFS lazy loading)
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        // Allow serving files from packages directory for WASM modules
        fs: {
            allow: ['..'],
        },
        proxy: {
            // CORS proxy for external MCP servers (same as worker/index.js for local dev)
            '/cors-proxy': {
                target: 'https://mcp.stripe.com', // Placeholder, bypass handles everything
                changeOrigin: true,
                bypass: async (req, res) => {
                    if (!res) return; // Guard for TypeScript

                    // Extract target URL from query parameter
                    const reqUrl = new URL(req.url!, `http://localhost`);
                    const targetUrl = reqUrl.searchParams.get('url');

                    if (!targetUrl) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Missing url parameter');
                        return false; // Don't continue to proxy
                    }

                    try {
                        // Forward headers from original request (filter out problematic ones)
                        const headers: Record<string, string> = {};
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (key.toLowerCase() !== 'host' &&
                                key.toLowerCase() !== 'origin' &&
                                key.toLowerCase() !== 'connection' &&
                                key.toLowerCase() !== 'content-length' &&
                                typeof value === 'string') {
                                headers[key] = value;
                            }
                        }

                        const method = req.method || 'GET';

                        // Only collect body for methods that support it
                        let body: Uint8Array | undefined;
                        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                            const chunks: Buffer[] = [];
                            for await (const chunk of req) {
                                chunks.push(Buffer.from(chunk));
                            }
                            const bodyBuffer = Buffer.concat(chunks);
                            if (bodyBuffer.length > 0) {
                                body = new Uint8Array(bodyBuffer);
                            }
                        }

                        // Make the actual request to target
                        const response = await fetch(targetUrl, {
                            method,
                            headers,
                            body: body as BodyInit | undefined,
                        });

                        // Build response headers with CORS
                        const responseHeaders: Record<string, string> = {
                            'Access-Control-Allow-Origin': (req.headers.origin as string) || '*',
                            'Access-Control-Expose-Headers': '*',
                        };
                        response.headers.forEach((value, key) => {
                            if (key.toLowerCase() !== 'content-encoding') {
                                responseHeaders[key] = value;
                            }
                        });

                        res.writeHead(response.status, responseHeaders);

                        // Check if this is a streaming response (SSE)
                        // Also check URL pattern for Gemini streaming endpoints
                        const contentType = response.headers.get('content-type') || '';
                        const isStreamingEndpoint = targetUrl.includes('streamGenerateContent');
                        console.log('[CORS Proxy] Response status:', response.status, 'content-type:', contentType, 'isStreamingEndpoint:', isStreamingEndpoint);
                        if ((contentType.includes('text/event-stream') || isStreamingEndpoint) && response.body) {
                            console.log('[CORS Proxy] Streaming SSE response...');
                            // Stream the response for SSE - critical for Gemini/etc
                            const reader = response.body.getReader();
                            let chunkCount = 0;
                            const pump = async (): Promise<void> => {
                                const { done, value } = await reader.read();
                                if (done) {
                                    console.log('[CORS Proxy] Stream done, total chunks:', chunkCount);
                                    res.end();
                                    return;
                                }
                                chunkCount++;
                                console.log('[CORS Proxy] Chunk', chunkCount, 'size:', value.byteLength);
                                res.write(Buffer.from(value));
                                return pump();
                            };
                            await pump();
                        } else {
                            // Buffer non-streaming responses
                            const responseBody = await response.arrayBuffer();
                            console.log('[CORS Proxy] Buffered response size:', responseBody.byteLength);
                            res.end(Buffer.from(responseBody));
                        }
                    } catch (err) {
                        res.writeHead(502, { 'Content-Type': 'text/plain' });
                        res.end(`Proxy error: ${err}`);
                    }
                    return false; // Don't continue to proxy
                },
            },
            // Proxy API requests to backend
            '/messages': {
                target: 'http://localhost:3002',
                changeOrigin: true,
            },
            '/v1/messages': {
                target: 'http://localhost:3002',
                changeOrigin: true,
            },
            '/health': {
                target: 'http://localhost:3002',
                changeOrigin: true,
            },
        },
    },
    worker: {
        format: 'es',
    },
    optimizeDeps: {
        exclude: ['@wasmer/sdk'],
        // Include preview2-shim to ensure single module instance
        include: [
            '@bytecodealliance/preview2-shim/cli',
            '@bytecodealliance/preview2-shim/io',
            '@bytecodealliance/preview2-shim/random',
            '@bytecodealliance/preview2-shim/filesystem',
        ],
    },
    build: {
        target: 'esnext',
    },
    preview: {
        headers: {
            // Required for SharedArrayBuffer (needed for OPFS lazy loading)
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
}));
