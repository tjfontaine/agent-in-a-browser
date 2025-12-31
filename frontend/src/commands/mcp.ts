/**
 * MCP State Management
 * 
 * Manages MCP state for the application.
 */

import { getRemoteMCPRegistry } from '../mcp';

// State references - will be set during initialization
let mcpInitialized = false;
let mcpServerInfo: { name: string; version: string } | null = null;
let mcpToolsList: Array<{ name: string; description?: string }> = [];

/**
 * Set MCP state from sandbox initialization.
 */
export function setMcpState(
    initialized: boolean,
    serverInfo: { name: string; version: string } | null,
    tools: Array<{ name: string; description?: string }>
): void {
    mcpInitialized = initialized;
    mcpServerInfo = serverInfo;
    mcpToolsList = tools;
}

/**
 * Get current MCP initialization state.
 */
export function isMcpInitialized(): boolean {
    return mcpInitialized;
}

/**
 * Get MCP status data.
 */
export function getMcpStatusData(): {
    initialized: boolean;
    serverInfo: { name: string; version: string } | null;
    tools: Array<{ name: string; description?: string }>;
    remoteServers: Array<{
        id: string;
        name: string;
        url: string;
        status: string;
        toolCount: number;
    }>;
} {
    const registry = getRemoteMCPRegistry();
    const remoteServers = registry.getServers().map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        status: s.status,
        toolCount: s.tools.length,
    }));

    return {
        initialized: mcpInitialized,
        serverInfo: mcpServerInfo,
        tools: mcpToolsList,
        remoteServers,
    };
}

