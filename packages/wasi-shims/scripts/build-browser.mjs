/**
 * Build browser-compatible bundle of wasi-shims
 * 
 * Creates per-module ESM bundles with all internal dependencies inlined.
 * These bundles use globalThis to share class instances across modules.
 */

import * as esbuild from 'esbuild';
import { mkdir, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const browserDistDir = join(rootDir, 'browser-dist');

async function build() {
    console.log('Building browser-compatible wasi-shims bundles...');

    // Ensure output directory exists
    await mkdir(browserDistDir, { recursive: true });

    // Find all JS files in dist
    const files = await readdir(distDir);
    const jsFiles = files.filter(f => f.endsWith('.js'));

    // Bundle each file with its dependencies
    for (const file of jsFiles) {
        const entryPoint = join(distDir, file);
        const outfile = join(browserDistDir, file);

        try {
            await esbuild.build({
                entryPoints: [entryPoint],
                bundle: true,
                format: 'esm',
                platform: 'browser',
                target: 'esnext',
                outfile,
                sourcemap: true,
                external: [
                    // External packages that Vite will bundle
                    '@bytecodealliance/preview2-shim',
                    '@bytecodealliance/preview2-shim/*',
                ],
                minify: false,
                keepNames: true,
            });
            console.log(`  ✓ ${file}`);
        } catch (err) {
            console.error(`  ✗ ${file}: ${err.message}`);
        }
    }

    console.log(`\nBrowser bundles written to: ${browserDistDir}`);
}

build().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});
