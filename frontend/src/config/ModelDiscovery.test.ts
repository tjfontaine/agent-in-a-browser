/**
 * Tests for Model Discovery
 * 
 * Tests API fetching, caching, alias generation, and model filtering.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    refreshModels,
    getCachedModels,
    isCacheStale,
    clearModelCache,
    backgroundRefreshModels,
} from './ModelDiscovery';
import * as providerConfig from '../provider-config';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Model Discovery', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        clearModelCache('anthropic');
        clearModelCache('openai');
        clearModelCache('custom');
    });

    afterEach(() => {
        providerConfig.clearAllSecrets();
    });

    describe('refreshModels', () => {
        it('throws error when no API key set', async () => {
            await expect(refreshModels('anthropic')).rejects.toThrow('No API key set');
        });

        it('fetches OpenAI models with correct headers', async () => {
            providerConfig.setApiKey('openai', 'sk-test-key');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'gpt-4o', owned_by: 'openai', created: 1700000000 },
                        { id: 'gpt-4o-mini', owned_by: 'openai', created: 1699000000 },
                    ],
                }),
            });

            const models = await refreshModels('openai');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.openai.com/v1/models',
                expect.objectContaining({
                    headers: { 'Authorization': 'Bearer sk-test-key' },
                })
            );
            expect(models.length).toBe(2);
            expect(models[0].id).toBe('gpt-4o'); // Sorted by creation date (newest first)
        });

        it('fetches Anthropic models with correct headers', async () => {
            providerConfig.setApiKey('anthropic', 'sk-ant-test-key');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2024-01-01T00:00:00Z' },
                        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2024-02-01T00:00:00Z' },
                    ],
                }),
            });

            const models = await refreshModels('anthropic');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.anthropic.com/v1/models',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-api-key': 'sk-ant-test-key',
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true',
                    }),
                })
            );
            expect(models.length).toBe(2);
            // Sorted by creation date, haiku is newer
            expect(models[0].id).toBe('claude-haiku-4-5');
        });

        it('filters out non-chat models', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'gpt-4o', owned_by: 'openai', created: 1700000000 },
                        { id: 'text-embedding-ada-002', owned_by: 'openai', created: 1699000000 },
                        { id: 'whisper-1', owned_by: 'openai', created: 1698000000 },
                        { id: 'dall-e-3', owned_by: 'openai', created: 1697000000 },
                        { id: 'tts-1', owned_by: 'openai', created: 1696000000 },
                    ],
                }),
            });

            const models = await refreshModels('openai');

            expect(models.length).toBe(1);
            expect(models[0].id).toBe('gpt-4o');
        });

        it('throws on API error', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            });

            await expect(refreshModels('openai')).rejects.toThrow('OpenAI API error: 401');
        });

        it('uses custom baseURL when set', async () => {
            providerConfig.setApiKey('openai', 'test');
            providerConfig.setProviderBaseURL('openai', 'https://custom-api.com/v1');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [] }),
            });

            await refreshModels('openai');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://custom-api.com/v1/models',
                expect.any(Object)
            );

            // Cleanup
            providerConfig.setProviderBaseURL('openai', '');
        });

        it('caches results after successful fetch', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [{ id: 'gpt-4o', owned_by: 'openai', created: 1700000000 }],
                }),
            });

            await refreshModels('openai');
            const cached = getCachedModels('openai');

            expect(cached.length).toBe(1);
            expect(cached[0].id).toBe('gpt-4o');
        });

        it('treats custom providers as OpenAI-compatible', async () => {
            providerConfig.addCustomProvider({
                id: 'groq',
                name: 'Groq',
                baseURL: 'https://api.groq.com/openai/v1',
            });
            providerConfig.setApiKey('groq', 'gsk-test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [{ id: 'llama-3-70b', owned_by: 'groq', created: 1700000000 }],
                }),
            });

            const models = await refreshModels('groq');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.groq.com/openai/v1/models',
                expect.any(Object)
            );

            // Cleanup
            providerConfig.removeCustomProvider('groq');
        });
    });

    describe('getCachedModels', () => {
        it('returns empty array when no cache', () => {
            const cached = getCachedModels('unknown-provider');
            expect(cached).toEqual([]);
        });
    });

    describe('isCacheStale', () => {
        it('returns true when no cache exists', () => {
            expect(isCacheStale('uncached-provider')).toBe(true);
        });

        it('returns false immediately after refresh', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: [] }),
            });

            await refreshModels('openai');
            expect(isCacheStale('openai')).toBe(false);
        });
    });

    describe('clearModelCache', () => {
        it('clears cached models for provider', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [{ id: 'gpt-4o', owned_by: 'openai', created: 1700000000 }],
                }),
            });

            await refreshModels('openai');
            expect(getCachedModels('openai').length).toBe(1);

            clearModelCache('openai');
            expect(getCachedModels('openai')).toEqual([]);
            expect(isCacheStale('openai')).toBe(true);
        });
    });

    describe('backgroundRefreshModels', () => {
        it('does not throw on error', () => {
            // No API key set - would normally throw
            expect(() => backgroundRefreshModels('anthropic')).not.toThrow();
        });

        it('logs warning on error', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            backgroundRefreshModels('no-key-provider');

            // Wait for async operation
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

    describe('Model formatting and aliases', () => {
        it('generates aliases for GPT models', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'gpt-5.2', owned_by: 'openai', created: 1700000000 },
                        { id: 'gpt-4o-mini', owned_by: 'openai', created: 1699000000 },
                    ],
                }),
            });

            const models = await refreshModels('openai');

            const gpt52 = models.find(m => m.id === 'gpt-5.2');
            expect(gpt52?.aliases).toContain('5.2');

            const mini = models.find(m => m.id === 'gpt-4o-mini');
            expect(mini?.aliases).toContain('4o-mini');
            expect(mini?.aliases).toContain('mini');
        });

        it('generates aliases for Claude models', async () => {
            providerConfig.setApiKey('anthropic', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'claude-3-5-sonnet-20240620', display_name: 'Claude Sonnet', created_at: '2024-06-20T00:00:00Z' },
                        { id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku', created_at: '2024-03-07T00:00:00Z' },
                    ],
                }),
            });

            const models = await refreshModels('anthropic');

            const sonnet = models.find(m => m.id.includes('sonnet'));
            expect(sonnet?.aliases).toContain('sonnet');
            expect(sonnet?.aliases).toContain('s');

            const haiku = models.find(m => m.id.includes('haiku'));
            expect(haiku?.aliases).toContain('haiku');
            expect(haiku?.aliases).toContain('h');
        });

        it('formats model names to be human-readable', async () => {
            providerConfig.setApiKey('openai', 'test');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: [
                        { id: 'gpt-4o', owned_by: 'openai', created: 1700000000 },
                    ],
                }),
            });

            const models = await refreshModels('openai');

            expect(models[0].name).toBe('GPT 4o');
        });
    });
});
