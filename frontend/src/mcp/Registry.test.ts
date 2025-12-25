/**
 * Tests for Remote MCP Server Registry
 * 
 * Tests server management, storage, and registry functionality.
 * Note: Connection tests require mocking the AI SDK MCP client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    getRemoteMCPRegistry,
    RemoteMCPRegistry,
} from './Registry';

// Mock localStorage
const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
    };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock oauth-pkce module
vi.mock('../auth/OAuthPkce', () => ({
    authenticateWithServer: vi.fn(),
    getToken: vi.fn(() => null),
    removeToken: vi.fn(),
    hasValidToken: vi.fn(() => false),
    discoverOAuthEndpoints: vi.fn(),
}));

// Mock AI SDK MCP client
vi.mock('@ai-sdk/mcp', () => ({
    experimental_createMCPClient: vi.fn(),
}));

// Reset singleton between tests
let registry: RemoteMCPRegistry;

describe('Remote MCP Registry', () => {
    beforeEach(() => {
        localStorageMock.clear();
        // Create a fresh registry for each test
        registry = new RemoteMCPRegistry();
    });

    describe('getServers', () => {
        it('returns empty array initially', () => {
            const servers = registry.getServers();
            expect(servers).toEqual([]);
        });

        it('returns servers after adding', async () => {
            await registry.addServer({ url: 'https://mcp.example.com' });
            const servers = registry.getServers();
            expect(servers.length).toBe(1);
        });
    });

    describe('addServer', () => {
        it('adds a server with minimal config', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
            });
            expect(server.id).toBeDefined();
            expect(server.url).toBe('https://mcp.example.com');
            expect(server.status).toBe('disconnected');
        });

        it('uses URL hostname as default name', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.stripe.com/v1',
            });
            expect(server.name).toBe('mcp.stripe.com');
        });

        it('uses provided name', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
                name: 'My MCP Server',
            });
            expect(server.name).toBe('My MCP Server');
        });

        it('defaults to none authType', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
            });
            expect(server.authType).toBe('none');
        });

        it('accepts oauth authType', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
                authType: 'oauth',
            });
            expect(server.authType).toBe('oauth');
        });

        it('accepts bearer authType with token', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
                authType: 'bearer',
                bearerToken: 'test-token',
            });
            expect(server.authType).toBe('bearer');
            // bearerToken is stored on the server object - need to set via setBearerToken 
            // after addServer for it to persist (addServer creates with template)
            registry.setBearerToken(server.id, 'test-token');
            const updated = registry.getServer(server.id);
            expect(updated?.bearerToken).toBe('test-token');
        });

        it('throws for duplicate server', async () => {
            await registry.addServer({ url: 'https://mcp.example.com' });
            await expect(
                registry.addServer({ url: 'https://mcp.example.com' })
            ).rejects.toThrow('already registered');
        });

        it('persists to localStorage', async () => {
            await registry.addServer({ url: 'https://mcp.example.com' });
            const stored = localStorageMock.getItem('mcp_remote_servers');
            expect(stored).toBeDefined();
            expect(stored).toContain('mcp.example.com');
        });
    });

    describe('removeServer', () => {
        it('removes an existing server', async () => {
            const server = await registry.addServer({ url: 'https://mcp.example.com' });
            await registry.removeServer(server.id);
            expect(registry.getServers()).toEqual([]);
        });

        it('removes from localStorage', async () => {
            const server = await registry.addServer({ url: 'https://mcp.example.com' });
            await registry.removeServer(server.id);
            const stored = localStorageMock.getItem('mcp_remote_servers');
            expect(stored).toBe('[]'); // Empty array
        });

        it('throws for non-existent server', async () => {
            await expect(registry.removeServer('non-existent')).rejects.toThrow('Server not found');
        });
    });

    describe('getServer', () => {
        it('returns server by ID', async () => {
            const server = await registry.addServer({ url: 'https://mcp.example.com' });
            const found = registry.getServer(server.id);
            expect(found).toBeDefined();
            expect(found?.url).toBe('https://mcp.example.com');
        });

        it('returns undefined for unknown ID', () => {
            const found = registry.getServer('unknown-id');
            expect(found).toBeUndefined();
        });
    });

    describe('subscribe / unsubscribe', () => {
        it('notifies listeners on addServer', async () => {
            const listener = vi.fn();
            registry.subscribe(listener);
            await registry.addServer({ url: 'https://mcp.example.com' });
            expect(listener).toHaveBeenCalled();
        });

        it('notifies listeners on removeServer', async () => {
            const server = await registry.addServer({ url: 'https://mcp.example.com' });
            const listener = vi.fn();
            registry.subscribe(listener);
            await registry.removeServer(server.id);
            expect(listener).toHaveBeenCalled();
        });

        it('returns unsubscribe function', async () => {
            const listener = vi.fn();
            const unsubscribe = registry.subscribe(listener);
            unsubscribe();
            await registry.addServer({ url: 'https://new.example.com' });
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('getAggregatedTools', () => {
        it('returns empty object when no servers connected', () => {
            const tools = registry.getAggregatedTools();
            expect(tools).toEqual({});
        });
    });

    describe('getAllTools', () => {
        it('returns empty array when no servers connected', () => {
            const tools = registry.getAllTools();
            expect(tools).toEqual([]);
        });
    });

    describe('getConnectedCount', () => {
        it('returns 0 when no servers connected', () => {
            expect(registry.getConnectedCount()).toBe(0);
        });
    });

    describe('setBearerToken', () => {
        it('sets bearer token on server', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
                authType: 'bearer',
            });
            registry.setBearerToken(server.id, 'new-token');
            const updated = registry.getServer(server.id);
            expect(updated?.bearerToken).toBe('new-token');
        });
    });

    describe('clearBearerToken', () => {
        it('clears bearer token from server', async () => {
            const server = await registry.addServer({
                url: 'https://mcp.example.com',
                authType: 'bearer',
                bearerToken: 'token-to-clear',
            });
            registry.clearBearerToken(server.id);
            const updated = registry.getServer(server.id);
            expect(updated?.bearerToken).toBeUndefined();
        });
    });

    describe('generateId', () => {
        it('generates consistent IDs for same URL', async () => {
            const server1 = await registry.addServer({ url: 'https://mcp.example.com' });
            await registry.removeServer(server1.id);
            const server2 = await registry.addServer({ url: 'https://mcp.example.com' });
            // IDs should be consistent (based on URL hash)
            expect(server1.id).toBe(server2.id);
        });

        it('generates different IDs for different URLs', async () => {
            const server1 = await registry.addServer({ url: 'https://mcp1.example.com' });
            const server2 = await registry.addServer({ url: 'https://mcp2.example.com' });
            expect(server1.id).not.toBe(server2.id);
        });
    });

    describe('Storage persistence', () => {
        it('loads servers from localStorage', () => {
            // Pre-populate localStorage
            localStorageMock.setItem('mcp_remote_servers', JSON.stringify([
                {
                    id: 'test-id',
                    name: 'Test Server',
                    url: 'https://test.example.com',
                    authType: 'none',
                    status: 'disconnected',
                    tools: [],
                },
            ]));

            // Create new registry - should load from storage
            const newRegistry = new RemoteMCPRegistry();
            const servers = newRegistry.getServers();
            expect(servers.length).toBe(1);
            expect(servers[0].name).toBe('Test Server');
        });

        it('handles malformed localStorage gracefully', () => {
            localStorageMock.setItem('mcp_remote_servers', 'invalid-json');

            // Should not throw
            expect(() => new RemoteMCPRegistry()).not.toThrow();
        });

        it('resets status to disconnected on load', () => {
            // Pre-populate with "connected" status
            localStorageMock.setItem('mcp_remote_servers', JSON.stringify([
                {
                    id: 'test-id',
                    name: 'Test Server',
                    url: 'https://test.example.com',
                    authType: 'none',
                    status: 'connected',
                    tools: [],
                },
            ]));

            const newRegistry = new RemoteMCPRegistry();
            const servers = newRegistry.getServers();
            expect(servers[0].status).toBe('disconnected');
        });
    });
});

describe('getRemoteMCPRegistry singleton', () => {
    it('returns same instance on multiple calls', () => {
        const r1 = getRemoteMCPRegistry();
        const r2 = getRemoteMCPRegistry();
        expect(r1).toBe(r2);
    });
});
