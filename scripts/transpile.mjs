#!/usr/bin/env node
/**
 * Centralized JCO Transpile Script
 * 
 * Usage: node transpile.mjs [module...] [--sync]
 * 
 * All modules use:
 * - Same async-imports (JSPI mode)
 * - Same ghostty-cli shims (terminal integration)
 * - Same filesystem/http shims
 * 
 * Use --sync flag to build sync-mode versions (for Safari fallback).
 */

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TARGET = `${ROOT}/target/wasm32-wasip2/release`;
const PACKAGES = `${ROOT}/packages`;
const FRONTEND = `${ROOT}/frontend`;

// ============================================================
// WASI VERSION - Update when wit-bindgen changes
// ============================================================
const V = '0.2.6';

// ============================================================
// ASYNC-IMPORTS - All blocking operations for JSPI suspension
// ============================================================
const ASYNC_IMPORTS = [
    // IO
    `wasi:io/streams@${V}#[method]input-stream.blocking-read`,
    `wasi:io/streams@${V}#[method]output-stream.blocking-write-and-flush`,
    // Polling - required for HTTP response waiting
    `wasi:io/poll@${V}#[method]pollable.block`,
    `wasi:io/poll@${V}#poll`,
    // HTTP - future-incoming-response.get() is async to allow JSPI suspension
    // This allows callers that busy-wait on get() to properly suspend
    `wasi:http/types@0.2.4#[method]future-incoming-response.get`,
    // Filesystem
    `wasi:filesystem/types@${V}#[method]descriptor.read`,
    `wasi:filesystem/types@${V}#[method]descriptor.write`,
    `wasi:filesystem/types@${V}#[method]descriptor.read-directory`,
    `wasi:filesystem/types@${V}#[method]descriptor.open-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.stat`,
    `wasi:filesystem/types@${V}#[method]descriptor.stat-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.create-directory-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.unlink-file-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.remove-directory-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.rename-at`,
    `wasi:filesystem/types@${V}#[method]descriptor.symlink-at`,
    // MCP loader
    'mcp:module-loader/loader#get-lazy-module',
    'mcp:module-loader/loader#spawn-lazy-command',
    'mcp:module-loader/loader#spawn-worker-command',
    'mcp:module-loader/loader#spawn-interactive',
    'mcp:module-loader/loader#[method]lazy-process.try-wait',
    // Shell
    'shell:unix/command@0.1.0#run',
];

// ============================================================
// SHIMS - Use package imports for proper module deduplication
// ============================================================
// CRITICAL: Using @tjfontaine/wasi-shims package paths instead of relative paths
// ensures that Vite properly deduplicates the shim modules. Without this,
// the worker and transpiled TUI would import different module instances,
// causing "Not a valid Descriptor resource" instanceof check failures.

// JSPI SHIMS: Uses async opfs-filesystem-impl for JSPI suspension
const SHIMS = {
    'wasi:cli/*': '@tjfontaine/wasi-shims/ghostty-cli-shim.js#*',
    'wasi:clocks/*': '@tjfontaine/wasi-shims/clocks-impl.js#*',
    'wasi:filesystem/*': '@tjfontaine/wasi-shims/opfs-filesystem-impl.js#*',
    'wasi:io/poll': '@tjfontaine/wasi-shims/poll-impl.js',
    'wasi:io/streams': '@tjfontaine/wasi-shims/streams.js',
    'wasi:io/*': '@tjfontaine/wasi-shims/error.js#*',
    'wasi:random/*': '@tjfontaine/wasi-shims/random.js#*',
    'wasi:sockets/*': '@bytecodealliance/preview2-shim/sockets#*',
    'wasi:http/types': '@tjfontaine/wasi-shims/wasi-http-impl.js',
    'wasi:http/outgoing-handler': '@tjfontaine/wasi-shims/wasi-http-impl.js#outgoingHandler',
    'terminal:info/size': '@tjfontaine/wasi-shims/ghostty-cli-shim.js#size',
};

// SYNC SHIMS: Uses sync opfs-filesystem-sync-impl for Safari/non-JSPI browsers
// The sync impl uses Atomics.wait to block while helper worker does OPFS operations
const SYNC_SHIMS = {
    ...SHIMS,
    'wasi:filesystem/*': '@tjfontaine/wasi-shims/opfs-filesystem-sync-impl.js#*',
};

// ============================================================
// MODULES
// ============================================================
const MODULES = {
    'ts-runtime-mcp': {
        wasm: 'ts-runtime-mcp.wasm',
        jspiOut: `${PACKAGES}/mcp-wasm-server/mcp-server-jspi`,
        syncOut: `${PACKAGES}/mcp-wasm-server/mcp-server-sync`,
        shims: {
            ...SHIMS,
            'mcp:module-loader/loader': '../../../frontend/src/wasm/lazy-loading/module-loader-impl.js'
        },
        exports: ['wasi:cli/run@0.2.6#run', 'wasi:http/incoming-handler@0.2.4#handle', 'shell:unix/command@0.1.0#run'],
    },
    'tsx-engine': {
        wasm: 'tsx_engine.wasm',
        jspiOut: `${PACKAGES}/wasm-tsx/wasm`,
        syncOut: `${PACKAGES}/wasm-tsx/wasm-sync`,
        shims: SHIMS,
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'sqlite-module': {
        wasm: 'sqlite_module.wasm',
        jspiOut: `${PACKAGES}/wasm-sqlite/wasm`,
        syncOut: `${PACKAGES}/wasm-sqlite/wasm-sync`,
        shims: SHIMS,
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'ratatui-demo': {
        wasm: 'ratatui_demo.wasm',
        jspiOut: `${PACKAGES}/wasm-ratatui/wasm`,
        syncOut: `${PACKAGES}/wasm-ratatui/wasm-sync`,
        shims: SHIMS,
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'edtui-module': {
        wasm: 'edtui_module.wasm',
        jspiOut: `${PACKAGES}/wasm-vim/wasm`,
        syncOut: `${PACKAGES}/wasm-vim/wasm-sync`,
        shims: SHIMS,
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'web-agent-tui': {
        wasm: 'web_agent_tui.wasm',
        jspiOut: `${FRONTEND}/src/wasm/web-agent-tui`,
        syncOut: `${FRONTEND}/src/wasm/web-agent-tui-sync`,
        shims: {
            ...SHIMS,
            'shell:unix/command@0.1.0': '@tjfontaine/mcp-wasm-server/mcp-server-jspi/ts-runtime-mcp.js#command'
        },
        syncShims: {
            ...SYNC_SHIMS,
            'shell:unix/command@0.1.0': '@tjfontaine/mcp-wasm-server/mcp-server-sync/ts-runtime-mcp.js#command'
        },
        exports: ['run'],
    },
    'web-headless-agent': {
        wasm: 'web_headless_agent.wasm',
        jspiOut: `${PACKAGES}/web-agent-core/src/wasm`,
        syncOut: `${PACKAGES}/web-agent-core/src/wasm-sync`,
        shims: SHIMS,
        // All exported functions that may suspend need --async-exports for JSPI
        exports: ['create', 'send', 'poll'],
    },
};

// ============================================================
// BUILD
// ============================================================
function build(name, mod, syncMode) {
    const input = `${TARGET}/${mod.wasm}`;
    const output = syncMode ? (mod.syncOut || mod.jspiOut.replace('jspi', 'sync')) : mod.jspiOut;
    const args = ['npx', 'jco', 'transpile', input, '-o', output];

    if (syncMode) {
        // Sync mode: use synchronous shims that block via Atomics.wait
        // No --async-imports needed since sync shims don't return Promises
        args.push('--async-mode', 'sync', '--tla-compat');
    } else {
        args.push('--async-mode', 'jspi');
        for (const imp of ASYNC_IMPORTS) args.push('--async-imports', `'${imp}'`);
        for (const exp of (mod.exports || [])) args.push('--async-exports', `'${exp}'`);
    }

    // Use SYNC_SHIMS for sync mode to get sync filesystem implementation
    // Fall back to mod.syncShims, then merge mod.shims with SYNC_SHIMS (SYNC_SHIMS overrides)
    let shimsToUse;
    if (syncMode) {
        // SYNC_SHIMS must come last to override wasi:filesystem/* with the sync version
        shimsToUse = mod.syncShims || { ...mod.shims, ...SYNC_SHIMS };
    } else {
        shimsToUse = mod.shims || SHIMS;
    }
    for (const [k, v] of Object.entries(shimsToUse)) args.push('--map', `'${k}=${v}'`);
    args.push('--valid-lifting-optimization', '--name', name.replace(/_/g, '-'));

    return { cmd: args.join(' '), output: output.replace(ROOT + '/', '') };
}

// ============================================================
// POST-TRANSPILE PATCHING
// ============================================================
// JCO generates instanceof checks that fail across bundled chunks
// because each chunk may define its own class. We patch these to
// use Symbol-based validation that works across module boundaries.
import { readFileSync, writeFileSync, readdirSync } from 'fs';

function patchInstanceofChecks(outputDir) {
    // Resource classes that need patching with their WASI resource paths
    const resourcePatches = [
        { class: 'Pollable', symbol: 'wasi:io/poll@0.2.4#Pollable' },
        { class: 'InputStream', symbol: 'wasi:io/streams@0.2.4#InputStream' },
        { class: 'OutputStream', symbol: 'wasi:io/streams@0.2.4#OutputStream' },
        { class: 'Descriptor', symbol: 'wasi:filesystem/types@0.2.6#Descriptor' },
    ];

    // Find the main JS file in the output directory
    const files = readdirSync(outputDir).filter(f => f.endsWith('.js'));
    let patchCount = 0;

    for (const file of files) {
        const filePath = `${outputDir}/${file}`;
        let content = readFileSync(filePath, 'utf8');
        let modified = false;

        for (const { class: className, symbol } of resourcePatches) {
            // Match patterns like: instanceof ClassName
            // JCO generates: if (!(e instanceof ClassName)) { throw new TypeError('Resource error: Not a valid "ClassName" resource.'); }

            // Pattern 1: Direct instanceof in conditional
            const pattern1 = new RegExp(`instanceof\\s+${className}(?=[\\s;\\)\\]])`, 'g');
            if (pattern1.test(content)) {
                content = content.replace(pattern1, `?.[Symbol.for('${symbol}')]`);
                modified = true;
                patchCount++;
            }
        }

        // DIAGNOSTIC INJECTION: Include Descriptor diagnostic info IN the error message
        // Since SharedWorker console.error doesn't propagate to main page, we must
        // include the diagnostic info in the error string that gets serialized.
        // Inject a helper function at the top of the file and use it in error throws.
        if (content.includes('throw new TypeError(\'Resource error: Not a valid "Descriptor" resource.\');')) {
            // Add helper function at top of file (after first opening brace or before exports)
            const descriptorDiag = `
function _descriptorDiag(obj) {
  try {
    const info = {
      type: typeof obj,
      ctor: obj?.constructor?.name,
      hasSymbol: obj ? !!obj[Symbol.for('wasi:filesystem/types@0.2.6#Descriptor')] : false,
      symbols: obj ? Object.getOwnPropertySymbols(obj).map(s => s.toString()).slice(0,3) : [],
      keys: obj ? Object.keys(obj).slice(0,5) : []
    };
    return 'Resource error: Not a valid "Descriptor" resource. DIAG: ' + JSON.stringify(info);
  } catch (e) {
    return 'Resource error: Not a valid "Descriptor" resource. DIAG_ERROR: ' + e.message;
  }
}
`;
            // Insert after the first function or const declaration
            const insertPoint = content.indexOf('function ');
            if (insertPoint > 0) {
                content = content.slice(0, insertPoint) + descriptorDiag + content.slice(insertPoint);
                modified = true;
            }

            // Now replace the throw statements to use the helper
            // Use simpler pattern that handles whitespace variations
            // Match: if (!(varName ?.[Symbol.for('wasi:filesystem/types@0.2.6#Descriptor')])) {
            //   throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
            // }
            // Replace throw statement to call helper. Use capturing group for the variable name.
            const throwPattern = /if\s*\(\s*!\s*\((\w+)\s*\?\.\[Symbol\.for\('wasi:filesystem\/types@0\.2\.6#Descriptor'\)\]\)\s*\)\s*\{\s*throw new TypeError\('Resource error: Not a valid "Descriptor" resource\.'\);/g;
            content = content.replace(throwPattern, (match, varName) => {
                return `if (!(${varName} ?.[Symbol.for('wasi:filesystem/types@0.2.6#Descriptor')])) { throw new TypeError(_descriptorDiag(${varName}));`;
            });
            modified = true;
        }

        if (modified) {
            writeFileSync(filePath, content);
            console.log(`   ↳ Patched ${file}`);
        }
    }

    return patchCount;
}

// ============================================================
// MAIN
// ============================================================
import { existsSync, rmSync } from 'fs';

const args = process.argv.slice(2);
const syncMode = args.includes('--sync');
const names = args.filter(a => !a.startsWith('--'));
const targets = names.length ? names : Object.keys(MODULES);

console.log(`🔧 JCO Transpile (WASI ${V}, ${syncMode ? 'SYNC' : 'JSPI'})\n`);

for (const name of targets) {
    const mod = MODULES[name];
    if (!mod) {
        console.error(`❌ Unknown: ${name}\n   Available: ${Object.keys(MODULES).join(', ')}`);
        process.exit(1);
    }

    // Check that input WASM exists - fail early with clear error
    const inputWasm = `${TARGET}/${mod.wasm}`;
    if (!existsSync(inputWasm)) {
        console.error(`❌ Missing WASM: ${inputWasm}`);
        console.error(`   Run: cargo component build -p ${name} --release --target wasm32-wasip2`);
        process.exit(1);
    }

    const { cmd, output } = build(name, mod, syncMode);

    // Delete output directory to prevent stale files
    const outputDir = syncMode ? (mod.syncOut || mod.jspiOut.replace('jspi', 'sync')) : mod.jspiOut;
    if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
    }

    console.log(`📦 ${name} → ${output}`);

    try {
        execSync(cmd, { cwd: FRONTEND, stdio: 'inherit', shell: true });
        // Patch instanceof checks to use Symbol-based validation
        patchInstanceofChecks(outputDir);
    } catch {
        console.error(`   ✗ Failed`);
        process.exit(1);
    }
}

console.log('\n✅ Done');
