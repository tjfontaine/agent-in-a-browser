/**
 * Remote MCP Server Registry
 * 
 * Manages connections to multiple remote MCP servers via Streamable HTTP transport.
 * Integrates with the Vercel AI SDK's experimental MCP client.
 */

import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import {
    authenticateWithServer,
    getToken,
    removeToken,
    hasValidToken,
    discoverOAuthEndpoints,
    type StoredToken
} from './oauth-pkce';

// ============ Types ============

export type ServerAuthType = 'none' | 'bearer' | 'oauth';
export type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'auth_required' | 'error';

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export interface RemoteMCPServer {
    id: string;
    name: string;
    url: string;
    authType: ServerAuthType;
    status: ServerStatus;
    error?: string;
    tools: McpToolInfo[];
    serverInfo?: {
        name: string;
        version: string;
    };
    // OAuth configuration (discovered or configured)
    oauthClientId?: string;
}

export interface ServerConfig {
    url: string;
    name?: string;
    authType?: ServerAuthType;
    bearerToken?: string;
    oauthClientId?: string;
}

// Internal state for connected clients
interface ConnectedClient {
    client: Awaited<ReturnType<typeof createMCPClient>>;
    tools: Record<string, unknown>;
}

// ============ Storage ============

const REGISTRY_STORAGE_KEY = 'mcp_remote_servers';

function loadRegistry(): Map<string, RemoteMCPServer> {
    try {
        const json = localStorage.getItem(REGISTRY_STORAGE_KEY);
        if (!json) return new Map();

        const array: RemoteMCPServer[] = JSON.parse(json);
        const map = new Map<string, RemoteMCPServer>();

        for (const server of array) {
            // Reset runtime state on load
            server.status = 'disconnected';
            server.tools = [];
            delete server.error;
            map.set(server.id, server);
        }

        return map;
    } catch (e) {
        console.error('[RemoteMCP] Failed to load registry:', e);
        return new Map();
    }
}

function saveRegistry(servers: Map<string, RemoteMCPServer>): void {
    const array = Array.from(servers.values()).map(s => ({
        ...s,
        // Don't persist runtime state
        status: 'disconnected' as ServerStatus,
        tools: [],
        error: undefined,
    }));
    localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(array));
}

// ============ Registry Class ============

export class RemoteMCPRegistry {
    private servers: Map<string, RemoteMCPServer>;
    private clients: Map<string, ConnectedClient> = new Map();
    private listeners: Set<() => void> = new Set();

    constructor() {
        this.servers = loadRegistry();
        console.log('[RemoteMCP] Loaded', this.servers.size, 'servers from storage');
    }

    // ============ Event Handling ============

    /**
     * Subscribe to registry changes
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (e) {
                console.error('[RemoteMCP] Listener error:', e);
            }
        }
    }

    private updateServer(id: string, updates: Partial<RemoteMCPServer>): void {
        const server = this.servers.get(id);
        if (server) {
            Object.assign(server, updates);
            this.notify();
        }
    }

    // ============ Server Management ============

    /**
     * Get all registered servers
     */
    getServers(): RemoteMCPServer[] {
        return Array.from(this.servers.values());
    }

    /**
     * Get a server by ID
     */
    getServer(id: string): RemoteMCPServer | undefined {
        return this.servers.get(id);
    }

    /**
     * Generate a unique server ID from URL
     */
    private generateId(url: string): string {
        const urlObj = new URL(url);
        const base = urlObj.hostname.replace(/\./g, '-');
        const existing = Array.from(this.servers.keys()).filter(k => k.startsWith(base));
        if (existing.length === 0) return base;
        return `${base}-${existing.length + 1}`;
    }

    /**
     * Add a new remote MCP server
     */
    async addServer(config: ServerConfig): Promise<RemoteMCPServer> {
        const url = config.url.replace(/\/$/, ''); // Remove trailing slash

        // Check if already registered
        for (const server of this.servers.values()) {
            if (server.url === url) {
                throw new Error(`Server already registered: ${server.name} (${server.id})`);
            }
        }

        const id = this.generateId(url);
        const urlObj = new URL(url);

        const server: RemoteMCPServer = {
            id,
            name: config.name || urlObj.hostname,
            url,
            authType: config.authType || 'none',
            status: 'disconnected',
            tools: [],
            oauthClientId: config.oauthClientId,
        };

        this.servers.set(id, server);
        saveRegistry(this.servers);
        this.notify();

        console.log('[RemoteMCP] Added server:', id, url);
        return server;
    }

    /**
     * Remove a remote MCP server
     */
    async removeServer(id: string): Promise<void> {
        const server = this.servers.get(id);
        if (!server) {
            throw new Error(`Server not found: ${id}`);
        }

        // Disconnect if connected
        await this.disconnectServer(id);

        // Remove OAuth tokens
        removeToken(server.url);

        this.servers.delete(id);
        saveRegistry(this.servers);
        this.notify();

        console.log('[RemoteMCP] Removed server:', id);
    }

    // ============ Connection Management ============

    /**
     * Check if a server requires OAuth authentication
     */
    async checkAuthRequired(id: string): Promise<boolean> {
        const server = this.servers.get(id);
        if (!server) throw new Error(`Server not found: ${id}`);

        try {
            // Try to discover OAuth endpoints - if this succeeds, OAuth is required
            await discoverOAuthEndpoints(server.url);

            // Update auth type
            this.updateServer(id, { authType: 'oauth' });
            saveRegistry(this.servers);

            return true;
        } catch (_e) {
            // No OAuth metadata - might not need auth
            return false;
        }
    }

    /**
     * Initiate OAuth flow for a server
     */
    async authenticateServer(id: string, clientId?: string): Promise<StoredToken> {
        const server = this.servers.get(id);
        if (!server) throw new Error(`Server not found: ${id}`);

        const effectiveClientId = clientId || server.oauthClientId;
        if (!effectiveClientId) {
            throw new Error('OAuth client ID required. Use /mcp auth <id> <client_id>');
        }

        this.updateServer(id, { status: 'connecting', oauthClientId: effectiveClientId });

        try {
            const token = await authenticateWithServer(server.url, effectiveClientId);
            this.updateServer(id, { authType: 'oauth' });
            saveRegistry(this.servers);
            return token;
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            this.updateServer(id, { status: 'error', error: message });
            throw e;
        }
    }

    /**
     * Connect to a remote MCP server
     */
    async connectServer(id: string): Promise<void> {
        const server = this.servers.get(id);
        if (!server) throw new Error(`Server not found: ${id}`);

        // Check if already connected
        if (this.clients.has(id)) {
            console.log('[RemoteMCP] Already connected:', id);
            return;
        }

        this.updateServer(id, { status: 'connecting', error: undefined });

        try {
            // Build transport config based on auth type
            const transportConfig: { type: 'http'; url: string; headers?: Record<string, string> } = {
                type: 'http' as const,
                url: server.url,
            };

            if (server.authType === 'oauth') {
                // Check for valid token
                if (!hasValidToken(server.url)) {
                    this.updateServer(id, { status: 'auth_required' });
                    throw new Error('OAuth authentication required. Use /mcp auth ' + id);
                }

                const token = getToken(server.url);
                if (token) {
                    transportConfig.headers = {
                        Authorization: `Bearer ${token.accessToken}`,
                    };
                }
            }

            // Create MCP client
            console.log('[RemoteMCP] Connecting to:', server.url);
            const client = await createMCPClient({
                transport: transportConfig,
            });

            const tools = await client.tools();
            const toolList: McpToolInfo[] = Object.entries(tools).map(([name, tool]) => {
                const t = tool as { description?: string; parameters?: Record<string, unknown> };
                return {
                    name,
                    description: t.description,
                    inputSchema: t.parameters,
                };
            });

            console.log('[RemoteMCP] Connected, tools:', toolList.map(t => t.name));

            // Store client
            this.clients.set(id, { client, tools });

            this.updateServer(id, {
                status: 'connected',
                tools: toolList,
                error: undefined,
            });

        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('[RemoteMCP] Connection failed:', e);

            // Check if it's an auth error (401)
            if (message.includes('401') || message.includes('Unauthorized')) {
                this.updateServer(id, { status: 'auth_required', error: 'Authentication required' });
            } else {
                this.updateServer(id, { status: 'error', error: message });
            }

            throw e;
        }
    }

    /**
     * Disconnect from a remote MCP server
     */
    async disconnectServer(id: string): Promise<void> {
        const connectedClient = this.clients.get(id);
        if (connectedClient) {
            try {
                await connectedClient.client.close();
            } catch (e) {
                console.error('[RemoteMCP] Error closing client:', e);
            }
            this.clients.delete(id);
        }

        this.updateServer(id, { status: 'disconnected', tools: [] });
        console.log('[RemoteMCP] Disconnected:', id);
    }

    /**
     * Disconnect all servers
     */
    async disconnectAll(): Promise<void> {
        for (const id of this.clients.keys()) {
            await this.disconnectServer(id);
        }
    }

    // ============ Tool Aggregation ============

    /**
     * Get aggregated tools from all connected remote servers
     * Returns tools in Vercel AI SDK format
     */
    getAggregatedTools(): Record<string, unknown> {
        const allTools: Record<string, unknown> = {};

        for (const [id, { tools }] of this.clients) {
            const server = this.servers.get(id);
            const prefix = server ? `${server.id}_` : '';

            for (const [name, tool] of Object.entries(tools)) {
                // Prefix tool names to avoid collisions
                allTools[`${prefix}${name}`] = tool;
            }
        }

        return allTools;
    }

    /**
     * Get tool info for all connected servers
     */
    getAllTools(): McpToolInfo[] {
        const tools: McpToolInfo[] = [];

        for (const server of this.servers.values()) {
            if (server.status === 'connected') {
                for (const tool of server.tools) {
                    tools.push({
                        ...tool,
                        name: `${server.id}_${tool.name}`,
                    });
                }
            }
        }

        return tools;
    }

    /**
     * Get connected server count
     */
    getConnectedCount(): number {
        return this.clients.size;
    }
}

// ============ Singleton Instance ============

let registryInstance: RemoteMCPRegistry | null = null;

export function getRemoteMCPRegistry(): RemoteMCPRegistry {
    if (!registryInstance) {
        registryInstance = new RemoteMCPRegistry();
    }
    return registryInstance;
}
