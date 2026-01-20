#!/usr/bin/env node
/**
 * post-build patch: Add POLLABLE_MARKER Symbol to bundled preview2-shim Pollable
 * 
 * Problem: Vite bundles @bytecodealliance/preview2-shim/io which exports a bare
 * Pollable class without the Symbol marker. When module-loader-impl extends this
 * Pollable, the Symbol check fails.
 * 
 * Solution: Patch the bundled io-*.js file to add the Symbol marker constructor.
 */

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

const DIST_ASSETS = process.argv[2] || 'frontend/dist/assets';
const POLLABLE_MARKER = "Symbol.for('wasi:io/poll@0.2.4#Pollable')";

async function patchBundledPollable() {
    // Find all io-*.js files in dist/assets
    const ioFiles = await glob(`${DIST_ASSETS}/io-*.js`);

    if (ioFiles.length === 0) {
        console.log('No bundled io-*.js files found, skipping patch');
        return;
    }

    for (const file of ioFiles) {
        console.log(`Patching ${file}...`);
        let content = fs.readFileSync(file, 'utf-8');

        // Pattern: class t{} or class t {} (empty Pollable class)
        // Replace with a class that sets the Symbol marker in constructor
        const emptyClassPattern = /class\s+(\w+)\s*\{\s*\}(\s*const\s+\w+\s*=\s*\{Pollable:\1\})/g;

        const patched = content.replace(emptyClassPattern, (match, className, rest) => {
            // Replace empty class with one that has the marker
            return `class ${className}{constructor(){Object.defineProperty(this,${POLLABLE_MARKER},{value:true,enumerable:false})}}${rest}`;
        });

        if (patched !== content) {
            fs.writeFileSync(file, patched);
            console.log(`  ✅ Patched Pollable class in ${path.basename(file)}`);
        } else {
            // Try alternative pattern - already has some content
            console.log(`  ⚠️ No empty Pollable class found in ${path.basename(file)}, checking other patterns...`);

            // Try to find "class X{}" pattern in the minified code
            const minifiedPattern = /class (\w)\{\}(const \w=\{Pollable:\1\})/g;
            const patched2 = content.replace(minifiedPattern, (match, className, rest) => {
                return `class ${className}{constructor(){Object.defineProperty(this,${POLLABLE_MARKER},{value:true,enumerable:false})}}${rest}`;
            });

            if (patched2 !== content) {
                fs.writeFileSync(file, patched2);
                console.log(`  ✅ Patched minified Pollable class in ${path.basename(file)}`);
            } else {
                console.log(`  ℹ️ No patchable Pollable pattern found in ${path.basename(file)}`);
            }
        }
    }

    console.log('✅ Pollable patch complete');
}

patchBundledPollable().catch(err => {
    console.error('Failed to patch Pollable:', err);
    process.exit(1);
});
