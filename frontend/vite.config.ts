import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig(({ mode }) => ({
    // Custom domain: agent.atxconsulting.com (no subpath needed)
    base: '/',
    plugins: [
        react({
            babel: {
                plugins: [
                    ['babel-plugin-react-compiler', {}],
                ],
            },
        }),
        // Polyfill Node.js core modules for browser compatibility
        nodePolyfills({
            // Include specific polyfills needed by ink-web
            include: ['buffer', 'process', 'stream', 'events'],
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
            // Override util with our custom polyfill that includes isDeepStrictEqual
            overrides: {
                util: path.resolve(__dirname, './src/polyfills/util-polyfill.ts'),
            },
        }),
    ],
    resolve: {
        alias: {
            // Required for ink-web: redirect ink imports to ink-web
            ink: path.resolve(__dirname, 'node_modules/ink-web'),
            '@': path.resolve(__dirname, './src'),
            // Custom util polyfill that adds isDeepStrictEqual for @inkjs/ui
            'node:util': path.resolve(__dirname, './src/polyfills/util-polyfill.ts'),
            'util': path.resolve(__dirname, './src/polyfills/util-polyfill.ts'),
        },
    },
    server: {
        port: 3000,
        headers: {
            // Required for SharedArrayBuffer (needed for OPFS lazy loading)
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        proxy: {
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
