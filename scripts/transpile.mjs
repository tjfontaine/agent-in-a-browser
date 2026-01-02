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
    'mcp:module-loader/loader#spawn-interactive',
    'mcp:module-loader/loader#[method]lazy-process.try-wait',
    // Shell
    'shell:unix/command@0.1.0#run',
];

// ============================================================
// SHIMS - Ghostty by default for terminal integration
// ============================================================
const shims = (prefix) => ({
    'wasi:cli/*': `${prefix}/ghostty-cli-shim.js#*`,
    'wasi:clocks/*': `${prefix}/clocks-impl.js#*`,
    'wasi:filesystem/*': `${prefix}/opfs-filesystem-impl.js#*`,
    'wasi:io/poll': `${prefix}/poll-impl.js`,
    'wasi:io/*': '@bytecodealliance/preview2-shim/io#*',
    'wasi:random/*': '@bytecodealliance/preview2-shim/random#*',
    'wasi:sockets/*': '@bytecodealliance/preview2-shim/sockets#*',
    'wasi:http/types': `${prefix}/wasi-http-impl.js`,
    'wasi:http/outgoing-handler': `${prefix}/wasi-http-impl.js#outgoingHandler`,
    'terminal:info/size': `${prefix}/ghostty-cli-shim.js#size`,
});

// ============================================================
// MODULES
// ============================================================
const MODULES = {
    'ts-runtime-mcp': {
        wasm: 'ts-runtime-mcp.wasm',
        jspiOut: `${FRONTEND}/src/wasm/mcp-server-jspi`,
        syncOut: `${FRONTEND}/src/wasm/mcp-server-sync`,
        shims: {
            ...shims('../../../../packages/wasi-shims/src'),
            'mcp:module-loader/loader': '../lazy-loading/module-loader-impl.js'
        },
        exports: ['wasi:cli/run@0.2.6#run', 'wasi:http/incoming-handler@0.2.4#handle', 'shell:unix/command@0.1.0#run'],
    },
    'tsx-engine': {
        wasm: 'tsx_engine.wasm',
        jspiOut: `${PACKAGES}/wasm-tsx/wasm`,
        shims: shims('../../wasi-shims/src'),
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'sqlite-module': {
        wasm: 'sqlite_module.wasm',
        jspiOut: `${PACKAGES}/wasm-sqlite/wasm`,
        shims: shims('../../wasi-shims/src'),
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'ratatui-demo': {
        wasm: 'ratatui_demo.wasm',
        jspiOut: `${PACKAGES}/wasm-ratatui/wasm`,
        shims: shims('../../wasi-shims/src'),
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'edtui-module': {
        wasm: 'edtui_module.wasm',
        jspiOut: `${PACKAGES}/wasm-vim/wasm`,
        shims: shims('../../wasi-shims/src'),
        exports: ['shell:unix/command@0.1.0#run'],
    },
    'web-agent-tui': {
        wasm: 'web_agent_tui.wasm',
        jspiOut: `${FRONTEND}/src/wasm/web-agent-tui`,
        shims: {
            ...shims('../../../../packages/wasi-shims/src'),
            'shell:unix/command@0.1.0': '../mcp-server-jspi/ts-runtime-mcp.js#command'
        },
        exports: ['run'],
    },
};

// ============================================================
// BUILD
// ============================================================
function build(name, mod, syncMode) {
    const input = `${TARGET}/${mod.wasm}`;
    const output = syncMode ? (mod.syncOut || mod.jspiOut.replace('jspi', 'sync')) : mod.jspiOut;
    const args = ['jco', 'transpile', input, '-o', output];

    if (syncMode) {
        args.push('--async-mode', 'sync', '--tla-compat');
    } else {
        args.push('--async-mode', 'jspi');
        for (const imp of ASYNC_IMPORTS) args.push('--async-imports', `'${imp}'`);
        for (const exp of (mod.exports || [])) args.push('--async-exports', `'${exp}'`);
    }

    for (const [k, v] of Object.entries(mod.shims)) args.push('--map', `'${k}=${v}'`);
    args.push('--valid-lifting-optimization', '--name', name.replace(/_/g, '-'));

    return { cmd: args.join(' '), output: output.replace(ROOT + '/', '') };
}

// ============================================================
// MAIN
// ============================================================
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

    const { cmd, output } = build(name, mod, syncMode);
    console.log(`📦 ${name} → ${output}`);

    try {
        execSync(cmd, { cwd: FRONTEND, stdio: 'inherit', shell: true });
    } catch {
        console.error(`   ✗ Failed`);
        process.exit(1);
    }
}

console.log('\n✅ Done');
