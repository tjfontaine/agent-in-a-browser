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
            '@tjfontaine/wasi-shims': path.resolve(__dirname, '../packages/wasi-shims/src'),
            '@tjfontaine/wasm-loader': path.resolve(__dirname, '../packages/wasm-loader/dist'),
            // Enable packages outside frontend to resolve node polyfills
            'vite-plugin-node-polyfills/shims/buffer': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/buffer'),
            'vite-plugin-node-polyfills/shims/global': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/global'),
            'vite-plugin-node-polyfills/shims/process': path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims/process'),
        },
        // Dedupe preview2-shim to prevent multiple bundle copies (fixes instanceof checks)
        dedupe: [
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
