import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

export default defineConfig(({ mode }) => ({
    // GitHub Pages deploys to /agent-in-a-browser/
    base: mode === 'production' ? '/agent-in-a-browser/' : '/',
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
            include: ['buffer', 'process', 'util', 'stream', 'events'],
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
        }),
    ],
    resolve: {
        alias: {
            // Required for ink-web: redirect ink imports to ink-web
            ink: 'ink-web',
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 3000,
        headers: {
            // Required for SharedArrayBuffer (needed for Wasmer-JS)
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
}));
