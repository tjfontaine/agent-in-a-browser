import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 3000,
        headers: {
            // Required for SharedArrayBuffer (needed for Wasmer-JS)
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
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
});
