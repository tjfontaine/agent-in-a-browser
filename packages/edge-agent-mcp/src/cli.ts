#!/usr/bin/env node
/**
 * edge-agent-mcp — MCP bridge for Edge Agent.
 *
 * Usage:
 *   edge-agent-mcp                    Run (reads config, auto mode)
 *   edge-agent-mcp setup              First-time interactive setup
 *   edge-agent-mcp setup --headless   Non-interactive headless setup
 *   edge-agent-mcp status             Show config and connection state
 *   edge-agent-mcp --mode cloud       Override mode
 *   edge-agent-mcp --session abc123   Override session ID
 *
 * Claude Code config:
 *   claude mcp add edge-agent -- npx @tjfontaine/edge-agent-mcp
 */

import { type Config, type Mode, loadConfig, generateSessionId, configExists, saveConfig } from './config.js';
import { startStdioTransport, log } from './stdio.js';
import { createCloudHandler } from './modes/cloud.js';
import { createLocalHandler } from './modes/local.js';
import { createHeadlessHandler, isHeadlessAvailable } from './modes/headless.js';
import { runSetup, printStatus } from './setup.js';
import type { JsonRpcRequest, JsonRpcResponse } from './stdio.js';

// ============ Arg Parsing ============

interface CliArgs {
    subcommand: 'run' | 'setup' | 'status';
    mode?: Mode;
    session?: string;
    tenantId?: string;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { subcommand: 'run' };
    const rest = argv.slice(2); // skip node + script

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];

        if (arg === 'setup') {
            args.subcommand = 'setup';
        } else if (arg === 'status') {
            args.subcommand = 'status';
        } else if (arg === '--mode' && i + 1 < rest.length) {
            args.mode = rest[++i] as Mode;
        } else if (arg === '--headless') {
            args.mode = 'headless';
        } else if (arg === '--session' && i + 1 < rest.length) {
            args.session = rest[++i];
        } else if (arg === '--tenant' && i + 1 < rest.length) {
            args.tenantId = rest[++i];
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (arg === '--version' || arg === '-v') {
            console.log('0.1.0');
            process.exit(0);
        }
    }

    return args;
}

function printHelp(): void {
    console.log(`edge-agent-mcp — MCP bridge for Edge Agent

Usage:
  edge-agent-mcp                    Run (reads config, auto mode)
  edge-agent-mcp setup              First-time interactive setup
  edge-agent-mcp setup --headless   Non-interactive headless setup
  edge-agent-mcp status             Show config and connection state

Options:
  --mode <mode>       Override mode: auto, cloud, local, headless
  --session <id>      Override session ID
  --tenant <id>       Override tenant ID (default: personal)
  --help, -h          Show this help
  --version, -v       Show version

Claude Code:
  claude mcp add edge-agent -- npx @tjfontaine/edge-agent-mcp
`);
}

// ============ Mode Resolution ============

async function resolveMode(config: Config): Promise<Mode> {
    if (config.mode !== 'auto') {
        return config.mode;
    }

    // 1. Headless if wasmtime-runner available
    if (isHeadlessAvailable()) {
        log('Auto mode: wasmtime-runner found, using headless');
        return 'headless';
    }

    // 2. Local if browser responds on WebSocket (only if we have a TTY)
    if (process.stdin.isTTY) {
        if (await probeLocalBrowser(config.local.wsPort)) {
            log('Auto mode: local browser detected, using local');
            return 'local';
        }
    }

    // 3. Cloud (always available)
    log('Auto mode: using cloud');
    return 'cloud';
}

async function probeLocalBrowser(port: number): Promise<boolean> {
    try {
        const { default: WebSocket } = await import('ws');
        return new Promise((resolve) => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const timer = setTimeout(() => {
                ws.close();
                resolve(false);
            }, 1000);

            ws.on('open', () => {
                clearTimeout(timer);
                ws.close();
                resolve(true);
            });

            ws.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    } catch {
        return false;
    }
}

// ============ Main ============

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    // Handle subcommands
    if (args.subcommand === 'setup') {
        await runSetup({
            mode: args.mode,
            session: args.session,
            tenantId: args.tenantId,
        });
        return;
    }

    if (args.subcommand === 'status') {
        printStatus();
        return;
    }

    // Run mode — ensure we have a config
    let config = loadConfig();

    // Apply CLI overrides
    if (args.mode) config.mode = args.mode;
    if (args.session) config.session = args.session;
    if (args.tenantId) config.tenantId = args.tenantId;

    // Auto-generate session ID if missing
    if (!config.session) {
        config.session = generateSessionId();
        log(`Generated session ID: ${config.session}`);

        // Save so the same session is reused next time
        if (!configExists()) {
            saveConfig(config);
            log('Config saved to ~/.edge-agent/config.toml');
        }
    }

    // Resolve mode
    const mode = await resolveMode(config);
    log(`Mode: ${mode} | Session: ${config.session} | Tenant: ${config.tenantId}`);

    // Create handler for the resolved mode
    let handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

    switch (mode) {
        case 'cloud':
            handler = createCloudHandler(config);
            break;
        case 'local':
            handler = createLocalHandler(config);
            break;
        case 'headless':
            handler = createHeadlessHandler(config);
            break;
        default:
            // Auto should have been resolved above
            handler = createCloudHandler(config);
    }

    // Start the stdio transport
    startStdioTransport(handler);
}

main().catch((err) => {
    log(`Fatal: ${err}`);
    process.exit(1);
});
