/**
 * Configuration management for edge-agent-mcp.
 *
 * Reads/writes ~/.edge-agent/config.toml (simple key=value format).
 * Merges CLI args + env vars + file config.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    generateSessionId as _generateSessionId,
    getSessionUrl as _getSessionUrl,
    getMcpUrl as _getMcpUrl,
    getRelayWsUrl as _getRelayWsUrl,
} from '@tjfontaine/edge-agent-session';

export type Mode = 'auto' | 'cloud' | 'local' | 'headless';

export interface Config {
    session: string;
    tenantId: string;
    mode: Mode;
    cloud: {
        relayBase: string;
    };
    local: {
        wsPort: number;
    };
    headless: {
        workDir: string;
    };
}

const CONFIG_DIR = join(homedir(), '.edge-agent');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');

const DEFAULT_CONFIG: Config = {
    session: '',
    tenantId: 'personal',
    mode: 'auto',
    cloud: {
        relayBase: 'edge-agent.dev',
    },
    local: {
        wsPort: 3040,
    },
    headless: {
        workDir: join(homedir(), '.edge-agent', 'sandbox'),
    },
};

/**
 * Load config from ~/.edge-agent/config.toml, merged with defaults.
 */
export function loadConfig(): Config {
    const config = { ...DEFAULT_CONFIG };

    if (!existsSync(CONFIG_FILE)) {
        return config;
    }

    try {
        const content = readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = parseSimpleToml(content);

        if (parsed['session']) config.session = String(parsed['session']);
        if (parsed['tenant_id']) config.tenantId = String(parsed['tenant_id']);
        if (parsed['mode']) config.mode = String(parsed['mode']) as Mode;
        if (parsed['cloud.relay_base']) config.cloud.relayBase = String(parsed['cloud.relay_base']);
        if (parsed['local.ws_port']) config.local.wsPort = Number(parsed['local.ws_port']);
        if (parsed['headless.work_dir']) config.headless.workDir = String(parsed['headless.work_dir']);
    } catch {
        // Config file unreadable, use defaults
    }

    return config;
}

/**
 * Save config to ~/.edge-agent/config.toml.
 */
export function saveConfig(config: Config): void {
    mkdirSync(CONFIG_DIR, { recursive: true });

    const lines = [
        `session = "${config.session}"`,
        `tenant_id = "${config.tenantId}"`,
        `mode = "${config.mode}"`,
        '',
        '[cloud]',
        `relay_base = "${config.cloud.relayBase}"`,
        '',
        '[local]',
        `ws_port = ${config.local.wsPort}`,
        '',
        '[headless]',
        `work_dir = "${config.headless.workDir}"`,
        '',
    ];

    writeFileSync(CONFIG_FILE, lines.join('\n'), 'utf-8');
}

/**
 * Check if a config file exists.
 */
export function configExists(): boolean {
    return existsSync(CONFIG_FILE);
}

/**
 * Get the config directory path.
 */
export function getConfigDir(): string {
    return CONFIG_DIR;
}

/**
 * Generate a random session ID (128-bit hex).
 * Re-exported from @tjfontaine/edge-agent-session.
 */
export const generateSessionId = _generateSessionId;

/**
 * Build session URLs from config.
 * Uses shared URL builders with configurable domain from config.cloud.relayBase.
 */
export function getSessionUrls(config: Config): {
    sessionUrl: string;
    mcpUrl: string;
    wsUrl: string;
} {
    const opts = {
        sid: config.session,
        tenantId: config.tenantId,
        domain: `sessions.${config.cloud.relayBase}`,
    };
    return {
        sessionUrl: _getSessionUrl(opts),
        mcpUrl: _getMcpUrl(opts),
        wsUrl: _getRelayWsUrl(opts),
    };
}

// ============ Simple TOML Parser ============
// Only handles flat keys and [section] headers — enough for our config.

function parseSimpleToml(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    let currentSection = '';

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        // Section header
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1] + '.';
            continue;
        }

        // Key = value
        const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch) {
            const key = currentSection + kvMatch[1];
            let value = kvMatch[2].trim();
            // Strip quotes
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            result[key] = value;
        }
    }

    return result;
}
