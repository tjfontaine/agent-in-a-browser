/**
 * Frontend-specific session display helpers.
 *
 * Core session types, parsing, and URL builders are in @tjfontaine/edge-agent-session.
 * This file only contains presentation helpers for the relay overlay UI.
 */

import { getMcpUrl } from '@tjfontaine/edge-agent-session';

/**
 * Generate Claude Code MCP configuration JSON for a session.
 */
export function getClaudeCodeConfig(sid: string, tenantId: string): string {
    return JSON.stringify(
        {
            mcpServers: {
                'edge-agent': {
                    url: getMcpUrl({ sid, tenantId }),
                },
            },
        },
        null,
        2,
    );
}

/**
 * Generate the `claude mcp add` command for a session.
 */
export function getClaudeMcpAddCommand(sid: string, tenantId: string): string {
    return `claude mcp add edge-agent --transport http ${getMcpUrl({ sid, tenantId })}`;
}
