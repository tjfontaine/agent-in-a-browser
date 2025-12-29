/**
 * Tests for Provider Configuration
 * 
 * Tests provider selection, model resolution, secrets management,
 * and subscription patterns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    getAllProviders,
    getProvider,
    getCurrentProvider,
    setCurrentProvider,
    addCustomProvider,
    removeCustomProvider,
    getCurrentModel,
    setCurrentModel,
    setCustomModel,
    resolveModelId,
    getAvailableModelIds,

    setApiKey,
    getApiKey,
    hasApiKey,
    removeApiKey,
    clearApiKey,
    getProvidersWithKeys,
    clearAllSecrets,
    setProviderBaseURL,
    getProviderBaseURL,
    getEffectiveBaseURL,
    setBackendProxyURL,
    getBackendProxyURL,
    isBackendProxyEnabled,
    subscribeToChanges,
    getConfigSummary,
    BUILT_IN_PROVIDERS,
} from './provider-config';

// Reset state before each test
// Note: provider-config uses module-level state, so we need to reset carefully
beforeEach(() => {
    // Reset to defaults
    setCurrentProvider('anthropic');
    clearAllSecrets();
    setBackendProxyURL(null);
    // Remove any custom providers by their IDs
    // (cleanup from previous tests)
});

describe('Provider Configuration', () => {
    describe('getAllProviders', () => {
        it('returns built-in providers', () => {
            const providers = getAllProviders();
            expect(providers.length).toBeGreaterThanOrEqual(2);
            expect(providers.some(p => p.id === 'anthropic')).toBe(true);
            expect(providers.some(p => p.id === 'openai')).toBe(true);
        });

        it('includes custom providers when added', () => {
            const _custom = addCustomProvider({
                id: 'test-provider',
                name: 'Test Provider',
                baseURL: 'https://api.test.com',
            });
            const providers = getAllProviders();
            expect(providers.some(p => p.id === 'test-provider')).toBe(true);
            // Cleanup
            removeCustomProvider('test-provider');
        });
    });

    describe('getProvider', () => {
        it('finds provider by ID', () => {
            const provider = getProvider('anthropic');
            expect(provider).toBeDefined();
            expect(provider?.name).toBe('Anthropic');
        });

        it('finds provider by alias', () => {
            const provider = getProvider('claude');
            expect(provider).toBeDefined();
            expect(provider?.id).toBe('anthropic');
        });

        it('returns undefined for unknown provider', () => {
            const provider = getProvider('unknown-provider');
            expect(provider).toBeUndefined();
        });

        it('is case-insensitive', () => {
            expect(getProvider('ANTHROPIC')).toBeDefined();
            expect(getProvider('Claude')).toBeDefined();
        });
    });

    describe('getCurrentProvider / setCurrentProvider', () => {
        it('returns anthropic by default', () => {
            setCurrentProvider('anthropic');
            const provider = getCurrentProvider();
            expect(provider.id).toBe('anthropic');
        });

        it('switches provider by ID', () => {
            const result = setCurrentProvider('openai');
            expect(result).toBe(true);
            expect(getCurrentProvider().id).toBe('openai');
            // Reset
            setCurrentProvider('anthropic');
        });

        it('switches provider by alias', () => {
            const result = setCurrentProvider('gpt');
            expect(result).toBe(true);
            expect(getCurrentProvider().id).toBe('openai');
            // Reset
            setCurrentProvider('anthropic');
        });

        it('returns false for unknown provider', () => {
            const result = setCurrentProvider('unknown');
            expect(result).toBe(false);
        });

        it('resets model when switching providers', () => {
            setCurrentProvider('anthropic');
            setCurrentModel('claude-opus-4-5-20250514');
            setCurrentProvider('openai');
            // Model should be reset to first model of new provider
            const model = getCurrentModel();
            expect(model).toBe('gpt-5.2');
            // Reset
            setCurrentProvider('anthropic');
        });
    });

    describe('addCustomProvider / removeCustomProvider', () => {
        it('adds a custom provider', () => {
            const provider = addCustomProvider({
                id: 'ollama',
                name: 'Ollama',
                baseURL: 'http://localhost:11434',
            });
            expect(provider.id).toBe('ollama');
            expect(provider.type).toBe('openai'); // Custom providers use OpenAI format
            expect(provider.baseURL).toBe('http://localhost:11434');
            // Cleanup
            removeCustomProvider('ollama');
        });

        it('adds default model if none provided', () => {
            const provider = addCustomProvider({
                id: 'test-no-models',
                name: 'Test',
                baseURL: 'https://test.com',
            });
            expect(provider.models.length).toBe(1);
            expect(provider.models[0].id).toBe('default');
            // Cleanup
            removeCustomProvider('test-no-models');
        });

        it('uses provided models', () => {
            const provider = addCustomProvider({
                id: 'test-with-models',
                name: 'Test',
                baseURL: 'https://test.com',
                models: [
                    { id: 'llama-3', name: 'Llama 3', description: 'Meta Llama', aliases: ['llama'] },
                ],
            });
            expect(provider.models[0].id).toBe('llama-3');
            // Cleanup
            removeCustomProvider('test-with-models');
        });

        it('removes a custom provider', () => {
            addCustomProvider({ id: 'to-remove', name: 'Remove Me', baseURL: 'https://x.com' });
            const result = removeCustomProvider('to-remove');
            expect(result).toBe(true);
            expect(getProvider('to-remove')).toBeUndefined();
        });

        it('returns false when removing non-existent provider', () => {
            const result = removeCustomProvider('non-existent');
            expect(result).toBe(false);
        });

        it('switches to anthropic when removing current provider', () => {
            addCustomProvider({ id: 'current-custom', name: 'Current', baseURL: 'https://x.com' });
            setCurrentProvider('current-custom');
            removeCustomProvider('current-custom');
            expect(getCurrentProvider().id).toBe('anthropic');
        });
    });

    describe('Model Resolution', () => {
        beforeEach(() => {
            setCurrentProvider('anthropic');
        });

        it('resolves model by ID', () => {
            const id = resolveModelId('claude-sonnet-4-5');
            expect(id).toBe('claude-sonnet-4-5');
        });

        it('resolves model by alias', () => {
            const id = resolveModelId('sonnet');
            expect(id).toBe('claude-sonnet-4-5');
        });

        it('resolves model by alias (short form)', () => {
            const id = resolveModelId('s');
            expect(id).toBe('claude-sonnet-4-5');
        });

        it('is case-insensitive for aliases', () => {
            const id = resolveModelId('Sonnet');
            expect(id).toBe('claude-sonnet-4-5');
        });

        it('returns undefined for unknown model', () => {
            const id = resolveModelId('unknown-model');
            expect(id).toBeUndefined();
        });
    });

    describe('getCurrentModel / setCurrentModel', () => {
        beforeEach(() => {
            setCurrentProvider('anthropic');
        });

        it('sets model by ID', () => {
            const result = setCurrentModel('claude-opus-4-5-20250514');
            expect(result).toBe(true);
            expect(getCurrentModel()).toBe('claude-opus-4-5-20250514');
        });

        it('sets model by alias', () => {
            const result = setCurrentModel('opus');
            expect(result).toBe(true);
            expect(getCurrentModel()).toBe('claude-opus-4-5-20250514');
        });

        it('returns false for unknown model', () => {
            const result = setCurrentModel('unknown');
            expect(result).toBe(false);
        });
    });

    describe('setCustomModel', () => {
        it('sets any model ID without validation', () => {
            setCustomModel('any-custom-model-id');
            expect(getCurrentModel()).toBe('any-custom-model-id');
            // Reset
            setCurrentProvider('anthropic');
        });
    });

    describe('getAvailableModelIds', () => {
        beforeEach(() => {
            setCurrentProvider('anthropic');
        });

        it('returns model IDs and aliases', () => {
            const ids = getAvailableModelIds();
            expect(ids).toContain('claude-sonnet-4-5');
            expect(ids).toContain('sonnet');
            expect(ids).toContain('s');
        });
    });

    describe('Secrets Management', () => {
        beforeEach(() => {
            clearAllSecrets();
        });

        it('sets and gets API key', () => {
            setApiKey('anthropic', 'sk-ant-test123');
            expect(getApiKey('anthropic')).toBe('sk-ant-test123');
        });

        it('returns undefined for missing key', () => {
            expect(getApiKey('no-key-provider')).toBeUndefined();
        });

        it('hasApiKey returns correct state', () => {
            expect(hasApiKey('anthropic')).toBe(false);
            setApiKey('anthropic', 'test');
            expect(hasApiKey('anthropic')).toBe(true);
        });

        it('removes API key', () => {
            setApiKey('anthropic', 'test');
            removeApiKey('anthropic');
            expect(hasApiKey('anthropic')).toBe(false);
        });

        it('clearApiKey is alias for removeApiKey', () => {
            setApiKey('openai', 'test');
            clearApiKey('openai');
            expect(hasApiKey('openai')).toBe(false);
        });

        it('getProvidersWithKeys returns providers that have keys', () => {
            setApiKey('anthropic', 'key1');
            setApiKey('openai', 'key2');
            const providers = getProvidersWithKeys();
            expect(providers).toContain('anthropic');
            expect(providers).toContain('openai');
        });

        it('clearAllSecrets removes all keys', () => {
            setApiKey('anthropic', 'key1');
            setApiKey('openai', 'key2');
            clearAllSecrets();
            expect(getProvidersWithKeys()).toHaveLength(0);
        });
    });

    describe('Base URL Overrides', () => {
        it('sets and gets base URL override', () => {
            setProviderBaseURL('anthropic', 'https://custom.anthropic.com');
            expect(getProviderBaseURL('anthropic')).toBe('https://custom.anthropic.com');
            // Cleanup
            setProviderBaseURL('anthropic', '');
        });

        it('clears override when setting empty string', () => {
            setProviderBaseURL('anthropic', 'https://custom.com');
            setProviderBaseURL('anthropic', '');
            expect(getProviderBaseURL('anthropic')).toBeUndefined();
        });

        it('getEffectiveBaseURL returns override when set', () => {
            setProviderBaseURL('anthropic', 'https://override.com');
            expect(getEffectiveBaseURL('anthropic')).toBe('https://override.com');
            // Cleanup
            setProviderBaseURL('anthropic', '');
        });

        it('getEffectiveBaseURL returns default when no override', () => {
            const url = getEffectiveBaseURL('anthropic');
            expect(url).toBe('https://api.anthropic.com');
        });
    });

    describe('Backend Proxy', () => {
        it('is disabled by default', () => {
            expect(isBackendProxyEnabled()).toBe(false);
            expect(getBackendProxyURL()).toBeNull();
        });

        it('enables proxy when URL set', () => {
            setBackendProxyURL('http://localhost:3002');
            expect(isBackendProxyEnabled()).toBe(true);
            expect(getBackendProxyURL()).toBe('http://localhost:3002');
            // Cleanup
            setBackendProxyURL(null);
        });

        it('disables proxy when set to null', () => {
            setBackendProxyURL('http://localhost:3002');
            setBackendProxyURL(null);
            expect(isBackendProxyEnabled()).toBe(false);
        });
    });

    describe('subscribeToChanges', () => {
        it('notifies on provider change', () => {
            const listener = vi.fn();
            const unsubscribe = subscribeToChanges(listener);

            setCurrentProvider('openai');
            expect(listener).toHaveBeenCalled();

            unsubscribe();
            setCurrentProvider('anthropic');
        });

        it('notifies on model change', () => {
            setCurrentProvider('anthropic');
            const listener = vi.fn();
            const unsubscribe = subscribeToChanges(listener);

            setCurrentModel('opus');
            expect(listener).toHaveBeenCalled();

            unsubscribe();
        });

        it('notifies on API key change', () => {
            const listener = vi.fn();
            const unsubscribe = subscribeToChanges(listener);

            setApiKey('anthropic', 'test');
            expect(listener).toHaveBeenCalled();

            unsubscribe();
            clearAllSecrets();
        });

        it('unsubscribe stops notifications', () => {
            const listener = vi.fn();
            const unsubscribe = subscribeToChanges(listener);

            unsubscribe();
            setCurrentProvider('openai');
            expect(listener).not.toHaveBeenCalled();

            // Reset
            setCurrentProvider('anthropic');
        });
    });

    describe('getConfigSummary', () => {
        beforeEach(() => {
            setCurrentProvider('anthropic');
            clearAllSecrets();
            setBackendProxyURL(null);
        });

        it('returns current configuration', () => {
            const summary = getConfigSummary();
            expect(summary.provider.id).toBe('anthropic');
            expect(summary.hasKey).toBe(false);
            expect(summary.usingProxy).toBe(false);
        });

        it('reflects API key status', () => {
            setApiKey('anthropic', 'test');
            const summary = getConfigSummary();
            expect(summary.hasKey).toBe(true);
        });

        it('reflects proxy status for anthropic', () => {
            setBackendProxyURL('http://localhost:3002');
            const summary = getConfigSummary();
            expect(summary.usingProxy).toBe(true);
        });

        it('proxy status is false for openai even when set', () => {
            setCurrentProvider('openai');
            setBackendProxyURL('http://localhost:3002');
            const summary = getConfigSummary();
            expect(summary.usingProxy).toBe(false);
            // Reset
            setCurrentProvider('anthropic');
            setBackendProxyURL(null);
        });
    });

    describe('BUILT_IN_PROVIDERS export', () => {
        it('exports built-in providers constant', () => {
            expect(BUILT_IN_PROVIDERS).toBeDefined();
            expect(BUILT_IN_PROVIDERS.length).toBe(2);
            expect(BUILT_IN_PROVIDERS[0].id).toBe('anthropic');
            expect(BUILT_IN_PROVIDERS[1].id).toBe('openai');
        });

        it('anthropic has expected models', () => {
            const anthropic = BUILT_IN_PROVIDERS.find(p => p.id === 'anthropic');
            expect(anthropic?.models.length).toBeGreaterThanOrEqual(3);
            expect(anthropic?.models.some(m => m.id.includes('sonnet'))).toBe(true);
        });

        it('openai has expected models', () => {
            const openai = BUILT_IN_PROVIDERS.find(p => p.id === 'openai');
            expect(openai?.models.length).toBeGreaterThanOrEqual(4);
            expect(openai?.models.some(m => m.id.includes('gpt'))).toBe(true);
        });
    });
});
