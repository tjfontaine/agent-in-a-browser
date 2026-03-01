/**
 * Setup subcommand — first-time configuration.
 *
 * Interactive: prompts for mode + generates session ID.
 * Non-interactive: accepts --mode flag for CI.
 */

import * as readline from 'node:readline';
import {
    type Config,
    type Mode,
    loadConfig,
    saveConfig,
    configExists,
    generateSessionId,
    getSessionUrls,
} from './config.js';
import { isHeadlessAvailable } from './modes/headless.js';

interface SetupOptions {
    mode?: Mode;
    session?: string;
    tenantId?: string;
}

/**
 * Run the setup flow. Returns the final config.
 */
export async function runSetup(options: SetupOptions): Promise<Config> {
    const config = loadConfig();
    const isInteractive = process.stdin.isTTY === true;
    const existing = configExists();

    if (existing) {
        console.log('Existing config found. Current settings:');
        console.log(`  session:   ${config.session || '(none)'}`);
        console.log(`  tenant_id: ${config.tenantId}`);
        console.log(`  mode:      ${config.mode}`);
        console.log();
    }

    // Session ID
    if (options.session) {
        config.session = options.session;
    } else if (!config.session) {
        config.session = generateSessionId();
        console.log(`Generated session ID: ${config.session}`);
    }

    // Tenant ID
    if (options.tenantId) {
        config.tenantId = options.tenantId;
    }

    // Mode
    if (options.mode) {
        config.mode = options.mode;
    } else if (isInteractive && !existing) {
        config.mode = await promptMode();
    }

    // Save
    saveConfig(config);
    console.log();
    console.log('Config saved.');
    console.log();

    // Print connection info
    printConnectionInfo(config);

    return config;
}

async function promptMode(): Promise<Mode> {
    const headless = isHeadlessAvailable();

    console.log('Select execution mode:');
    console.log('  1. auto     - Auto-detect best mode (recommended)');
    console.log('  2. cloud    - Route through cloud relay (easiest)');
    console.log('  3. local    - Connect to browser on localhost');
    if (headless) {
        console.log('  4. headless - Run natively via wasmtime (no browser)');
    } else {
        console.log('  4. headless - Run natively via wasmtime (not available — wasmtime-runner not found)');
    }
    console.log();

    const answer = await question('Mode [1]: ');
    const choice = answer.trim() || '1';

    switch (choice) {
        case '1':
        case 'auto':
            return 'auto';
        case '2':
        case 'cloud':
            return 'cloud';
        case '3':
        case 'local':
            return 'local';
        case '4':
        case 'headless':
            return 'headless';
        default:
            console.log('Invalid choice, using auto.');
            return 'auto';
    }
}

function question(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

function printConnectionInfo(config: Config): void {
    const { sessionUrl, mcpUrl } = getSessionUrls(config);

    console.log('--- Claude Code Configuration ---');
    console.log();
    console.log('Option 1: Add via CLI');
    console.log(`  claude mcp add edge-agent --transport http ${mcpUrl}`);
    console.log();
    console.log('Option 2: Add via stdio (launch this process)');
    console.log('  claude mcp add edge-agent -- npx @tjfontaine/edge-agent-mcp');
    console.log();
    console.log('Option 3: JSON config (claude_desktop_config.json)');
    console.log(
        JSON.stringify(
            {
                mcpServers: {
                    'edge-agent': { url: mcpUrl },
                },
            },
            null,
            2,
        ),
    );
    console.log();
    console.log(`Browser URL: ${sessionUrl}`);
    console.log();
}

/**
 * Print current config status.
 */
export function printStatus(): void {
    if (!configExists()) {
        console.log('No config found. Run: npx @tjfontaine/edge-agent-mcp setup');
        return;
    }

    const config = loadConfig();
    const { sessionUrl, mcpUrl, wsUrl } = getSessionUrls(config);

    console.log('Edge Agent MCP Bridge Status');
    console.log();
    console.log(`  Session:     ${config.session}`);
    console.log(`  Tenant:      ${config.tenantId}`);
    console.log(`  Mode:        ${config.mode}`);
    console.log();
    console.log(`  Session URL: ${sessionUrl}`);
    console.log(`  MCP URL:     ${mcpUrl}`);
    console.log(`  WS URL:      ${wsUrl}`);
    console.log();
    console.log(`  Headless:    ${isHeadlessAvailable() ? 'available' : 'not available'}`);
}
