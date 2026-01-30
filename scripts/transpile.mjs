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
// WASI VERSION - Detected from WASM at runtime
// ============================================================
// ASYNC_IMPORTS versions MUST match what the WASM file exports.
// wit-bindgen 0.51.0 changed from 0.2.6 to 0.2.9.
// We detect the version by inspecting the WASM file.

/**
 * Detect WASI interface version from WASM file.
 * Tries wasm-tools first, then @bytecodealliance/jco wit as fallback.
 * Returns the version string (e.g., "0.2.6" or "0.2.9").
 */
function detectWasiVersion(wasmPath) {
    // Try wasm-tools first (if installed)
    try {
        const wit = execSync(`wasm-tools component wit "${wasmPath}" 2>&1`, { encoding: 'utf8' });
        const match = wit.match(/wasi:io\/poll@(\d+\.\d+\.\d+)/);
        if (match) {
            return match[1];
        }
        const fsMatch = wit.match(/wasi:filesystem\/types@(\d+\.\d+\.\d+)/);
        if (fsMatch) {
            return fsMatch[1];
        }
    } catch (e) {
        // wasm-tools not installed, try jco wit
    }

    // Fallback: try jco wit (available via npx)
    try {
        const wit = execSync(`npx @bytecodealliance/jco wit "${wasmPath}" 2>&1`, { encoding: 'utf8' });
        const match = wit.match(/wasi:io\/poll@(\d+\.\d+\.\d+)/);
        if (match) {
            return match[1];
        }
        const fsMatch = wit.match(/wasi:filesystem\/types@(\d+\.\d+\.\d+)/);
        if (fsMatch) {
            return fsMatch[1];
        }
    } catch (e) {
        console.warn(`[transpile] Warning: Could not detect WASI version from ${wasmPath}`);
    }

    // Default fallback - should match latest wit-bindgen
    console.warn(`[transpile] Using default WASI version 0.2.9`);
    return '0.2.9';
}

/**
 * Build ASYNC_IMPORTS list with the detected version.
 */
function buildAsyncImports(V) {
    return [
        // IO
        `wasi:io/streams@${V}#[method]input-stream.blocking-read`,
        `wasi:io/streams@${V}#[method]output-stream.blocking-write-and-flush`,
        // Polling - required for HTTP response waiting
        `wasi:io/poll@${V}#[method]pollable.block`,
        `wasi:io/poll@${V}#poll`,
        // HTTP - future-incoming-response.get() is async to allow JSPI suspension
        // This allows callers that busy-wait on get() to properly suspend
        `wasi:http/types@${V}#[method]future-incoming-response.get`,
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
}

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
        wasm: 'ts_runtime_mcp.wasm',
        jspiOut: `${PACKAGES}/mcp-wasm-server/mcp-server-jspi`,
        syncOut: `${PACKAGES}/mcp-wasm-server/mcp-server-sync`,
        shims: {
            ...SHIMS,
            'mcp:module-loader/loader': '../../../frontend/src/wasm/lazy-loading/module-loader-impl.js'
        },
        exports: ['wasi:cli/run@0.2.9#run', 'wasi:http/incoming-handler@0.2.9#handle', 'shell:unix/command@0.1.0#run'],
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
        exports: ['create', 'send', 'poll', 'listProviders', 'listModels', 'fetchModels'],
    },
    // iOS-specific build: uses local:// scheme for ES module imports via WKURLSchemeHandler
    'web-headless-agent-ios': {
        wasm: 'web_headless_agent.wasm',
        jspiOut: `${ROOT}/ios-edge-agent/EdgeAgent/Resources/WebRuntime/web-headless-agent`,
        syncOut: `${ROOT}/ios-edge-agent/EdgeAgent/Resources/WebRuntime/web-headless-agent-sync`,
        // local:// scheme paths served by WKURLSchemeHandler with CORS headers
        // JSPI mode uses web-headless-agent path
        shims: {
            'wasi:cli/*': 'local://web-headless-agent/shims/ghostty-cli-shim.js#*',
            'wasi:clocks/*': 'local://web-headless-agent/shims/clocks-impl.js#*',
            'wasi:filesystem/*': 'local://web-headless-agent/shims/opfs-filesystem-impl.js#*',
            'wasi:io/poll': 'local://web-headless-agent/shims/poll-impl.js',
            'wasi:io/streams': 'local://web-headless-agent/shims/streams.js',
            'wasi:io/*': 'local://web-headless-agent/shims/error.js#*',
            'wasi:random/*': 'local://web-headless-agent/shims/random.js#*',
            'wasi:sockets/*': 'local://web-headless-agent/shims/sockets-stub.js#*',
            'wasi:http/types': 'local://web-headless-agent/shims/wasi-http-impl.js',
            'wasi:http/outgoing-handler': 'local://web-headless-agent/shims/wasi-http-impl.js#outgoingHandler',
            'terminal:info/size': 'local://web-headless-agent/shims/ghostty-cli-shim.js#size',
        },
        // Sync mode uses web-headless-agent-sync path (must match output directory)
        syncShims: {
            'wasi:cli/*': 'local://web-headless-agent-sync/shims/ghostty-cli-shim.js#*',
            'wasi:clocks/*': 'local://web-headless-agent-sync/shims/clocks-impl.js#*',
            'wasi:filesystem/*': 'local://web-headless-agent-sync/shims/opfs-filesystem-sync-impl.js#*',
            'wasi:io/poll': 'local://web-headless-agent-sync/shims/poll-impl.js',
            'wasi:io/streams': 'local://web-headless-agent-sync/shims/streams.js',
            'wasi:io/*': 'local://web-headless-agent-sync/shims/error.js#*',
            'wasi:random/*': 'local://web-headless-agent-sync/shims/random.js#*',
            'wasi:sockets/*': 'local://web-headless-agent-sync/shims/sockets-stub.js#*',
            'wasi:http/types': 'local://web-headless-agent-sync/shims/wasi-http-impl.js',
            'wasi:http/outgoing-handler': 'local://web-headless-agent-sync/shims/wasi-http-impl.js#outgoingHandler',
            'terminal:info/size': 'local://web-headless-agent-sync/shims/ghostty-cli-shim.js#size',
        },
        exports: ['create', 'send', 'poll', 'listProviders', 'listModels', 'fetchModels'],
    },
};

// ============================================================
// BUILD
// ============================================================
function build(name, mod, syncMode) {
    const input = `${TARGET}/${mod.wasm}`;
    const output = syncMode ? (mod.syncOut || mod.jspiOut.replace('jspi', 'sync')) : mod.jspiOut;
    const args = ['npx', '@bytecodealliance/jco', 'transpile', input, '-o', output];

    const isIosTarget = name.includes('ios');

    if (syncMode && !isIosTarget) {
        // Non-iOS sync mode: use synchronous shims that block via Atomics.wait
        // No async handling needed since sync shims don't return Promises
        args.push('--async-mode', 'sync', '--tla-compat');
    } else if (syncMode && isIosTarget) {
        // iOS sync mode: Use true sync mode - Safari/iOS doesn't have WebAssembly JSPI.
        // The shims use JavaScript async/await and the polling pattern handles pending.
        // When block() returns (as a no-op), poll() gets Pending and the host retries.
        console.log(`📦 iOS target - using sync mode (no JSPI on Safari)`);
        args.push('--async-mode', 'sync', '--tla-compat');
    } else {
        args.push('--async-mode', 'jspi');
        // Detect WASI version from the WASM file and build ASYNC_IMPORTS with matching version
        const wasiVersion = detectWasiVersion(input);
        const asyncImports = buildAsyncImports(wasiVersion);
        console.log(`📦 Detected WASI version: ${wasiVersion}`);
        for (const imp of asyncImports) args.push('--async-imports', `'${imp}'`);
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
        { class: 'Pollable', symbol: 'wasi:io/poll@0.2.9#Pollable' },
        { class: 'InputStream', symbol: 'wasi:io/streams@0.2.9#InputStream' },
        { class: 'OutputStream', symbol: 'wasi:io/streams@0.2.9#OutputStream' },
        { class: 'Descriptor', symbol: 'wasi:filesystem/types@0.2.9#Descriptor' },
        { class: 'LazyProcess', symbol: 'mcp:module-loader/loader@0.1.0#LazyProcess' },
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

            if (className === 'LazyProcess') {
                // LazyProcess needs special handling because jco uses Object.create(LazyProcess.prototype)
                // which bypasses the constructor where own-property Symbol markers are set.
                // We use 'in' operator which checks the prototype chain for inherited properties.
                // Pattern: (varName instanceof LazyProcess) => (varName && (Symbol.for('...') in varName))
                const lazyProcessPattern = /(\w+)\s+instanceof\s+LazyProcess(?=[\s;\)\]])/g;
                const newContent = content.replace(lazyProcessPattern, (match, varName) => {
                    return `${varName} && (Symbol.for('${symbol}') in ${varName})`;
                });
                if (newContent !== content) {
                    content = newContent;
                    modified = true;
                    patchCount++;
                }
            } else {
                // Other classes use own-property Symbol marker (set in constructor)
                const pattern1 = new RegExp(`instanceof\\s+${className}(?=[\\s;\\)\\]])`, 'g');
                if (pattern1.test(content)) {
                    content = content.replace(pattern1, `?.[Symbol.for('${symbol}')]`);
                    modified = true;
                    patchCount++;
                }
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
      hasSymbol: obj ? !!obj[Symbol.for('wasi:filesystem/types@0.2.9#Descriptor')] : false,
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
            // Match: if (!(varName ?.[Symbol.for('wasi:filesystem/types@0.2.9#Descriptor')])) {
            //   throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
            // }
            // Replace throw statement to call helper. Use capturing group for the variable name.
            const throwPattern = /if\s*\(\s*!\s*\((\w+)\s*\?\.\[Symbol\.for\('wasi:filesystem\/types@0\.2\.9#Descriptor'\)\]\)\s*\)\s*\{\s*throw new TypeError\('Resource error: Not a valid "Descriptor" resource\.'\);/g;
            content = content.replace(throwPattern, (match, varName) => {
                return `if (!(${varName} ?.[Symbol.for('wasi:filesystem/types@0.2.9#Descriptor')])) { throw new TypeError(_descriptorDiag(${varName}));`;
            });
            modified = true;
        }

        // DIAGNOSTIC INJECTION: Include LazyProcess diagnostic info IN the error message
        // Similar to Descriptor, we need to understand why Symbol.for(...) in ret fails
        if (content.includes('throw new TypeError(\'Resource error: Not a valid "LazyProcess" resource.\'')) {
            // Add helper function at top of file  
            const lazyProcessDiag = `
function _lazyProcessDiag(obj) {
  try {
    const symKey = Symbol.for('mcp:module-loader/loader@0.1.0#LazyProcess');
    const info = {
      type: typeof obj,
      isNull: obj === null,
      isUndefined: obj === undefined,
      ctor: obj?.constructor?.name,
      hasSymbolIn: obj ? (symKey in obj) : false,
      hasSymbolOwn: obj ? Object.prototype.hasOwnProperty.call(obj, symKey) : false,
      prototypeHasSymbol: obj ? (symKey in Object.getPrototypeOf(obj) ?? {}) : false,
      prototypeConstructor: obj ? Object.getPrototypeOf(obj)?.constructor?.name : null,
      symbols: obj ? Object.getOwnPropertySymbols(obj).map(s => s.toString()).slice(0,3) : [],
      protoSymbols: obj ? Object.getOwnPropertySymbols(Object.getPrototypeOf(obj) ?? {}).map(s => s.toString()).slice(0,3) : [],
      keys: obj ? Object.keys(obj).slice(0,5) : []
    };
    return 'Resource error: Not a valid "LazyProcess" resource. DIAG: ' + JSON.stringify(info);
  } catch (e) {
    return 'Resource error: Not a valid "LazyProcess" resource. DIAG_ERROR: ' + e.message;
  }
}
`;
            // Insert after the first function or const declaration
            const insertPoint = content.indexOf('function ');
            if (insertPoint > 0 && !content.includes('_lazyProcessDiag')) {
                content = content.slice(0, insertPoint) + lazyProcessDiag + content.slice(insertPoint);
                modified = true;
            }

            // Now replace the throw statements to use the helper
            // Match: if (!(varName && (Symbol.for('mcp:...#LazyProcess') in varName))) {
            //   throw new TypeError('Resource error: Not a valid "LazyProcess" resource.');
            // }
            const lazyThrowPattern = /if\s*\(\s*!\s*\((\w+)\s*&&\s*\(Symbol\.for\('mcp:module-loader\/loader@0\.1\.0#LazyProcess'\)\s*in\s*\1\)\)\s*\)\s*\{\s*throw new TypeError\('Resource error: Not a valid "LazyProcess" resource\.'\);/g;
            content = content.replace(lazyThrowPattern, (match, varName) => {
                return `if (!(${varName} && (Symbol.for('mcp:module-loader/loader@0.1.0#LazyProcess') in ${varName}))) { throw new TypeError(_lazyProcessDiag(${varName}));`;
            });
            modified = true;
        }

        if (modified) {
            writeFileSync(filePath, content);
            console.log(`   ↳ Patched ${file} `);
        }
    }

    return patchCount;
}

// ============================================================
// POST-TRANSPILE SHIM COPYING FOR iOS
// ============================================================
// iOS targets use local:// URLs for shims, served by WKURLSchemeHandler.
// Since jco clears the output directory, we need to copy the browser-bundled
// shims AFTER transpile completes.
import { mkdirSync, cpSync, readdirSync as readdirSyncFs } from 'fs';

function copyShimsForIOS(outputDir, name) {
    // Only copy shims for iOS targets
    if (!name.includes('ios')) return;

    const shimsSource = `${PACKAGES}/wasi-shims/browser-dist`;
    const shimsTarget = `${outputDir}/shims`;

    // Check if browser-dist exists
    if (!existsSync(shimsSource)) {
        console.warn(`   ⚠ wasi-shims/browser-dist not found - run 'pnpm run build:browser' in packages/wasi-shims`);
        return;
    }

    // Create shims directory and copy all JS files
    mkdirSync(shimsTarget, { recursive: true });
    const files = readdirSyncFs(shimsSource).filter(f => f.endsWith('.js'));
    for (const file of files) {
        cpSync(`${shimsSource}/${file}`, `${shimsTarget}/${file}`);
    }
    console.log(`   ↳ Copied ${files.length} shims to ${shimsTarget.replace(ROOT + '/', '')}`);
}

// ============================================================
// MAIN
// ============================================================
import { existsSync, rmSync } from 'fs';

const args = process.argv.slice(2);
const syncMode = args.includes('--sync');
const names = args.filter(a => !a.startsWith('--'));
const targets = names.length ? names : Object.keys(MODULES);

console.log(`🔧 JCO Transpile(${syncMode ? 'SYNC' : 'JSPI'}) \n`);

for (const name of targets) {
    const mod = MODULES[name];
    if (!mod) {
        console.error(`❌ Unknown: ${name} \n   Available: ${Object.keys(MODULES).join(', ')} `);
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
        // Copy shims for iOS targets (after jco clears output dir)
        copyShimsForIOS(outputDir, name);
    } catch {
        console.error(`   ✗ Failed`);
        process.exit(1);
    }
}

console.log('\n✅ Done');
