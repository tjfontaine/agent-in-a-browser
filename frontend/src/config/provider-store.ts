/**
 * Provider Store - Zustand State Management
 * 
 * Central store for provider, model, and secrets state.
 * Replaces manual pub/sub patterns with reactive state.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ModelInfo, ProviderInfo, ChangeListener } from './types';
import {
    BUILT_IN_PROVIDERS,
    DEFAULT_PROVIDER_ID,
    DEFAULT_MODEL_ID
} from './built-in-providers';

// ============================================================
// STORE STATE & ACTIONS
// ============================================================

interface ProviderState {
    // Current selections
    currentProviderId: string;
    currentModelId: string;

    // Custom providers added by user
    customProviders: ProviderInfo[];

    // Secrets (in-memory only)
    apiKeys: Map<string, string>;
    baseURLOverrides: Map<string, string>;
    backendProxyURL: string | null;

    // Legacy listeners for backward compatibility
    legacyListeners: Set<ChangeListener>;

    // Actions
    setCurrentProvider: (idOrAlias: string) => boolean;
    setCurrentModel: (idOrAlias: string) => boolean;
    setCustomModel: (modelId: string) => void;
    addCustomProvider: (config: { id: string; name: string; baseURL: string; models?: ModelInfo[] }) => ProviderInfo;
    removeCustomProvider: (id: string) => boolean;

    // Secrets actions
    setApiKey: (providerId: string, apiKey: string) => void;
    getApiKey: (providerId: string) => string | undefined;
    hasApiKey: (providerId: string) => boolean;
    removeApiKey: (providerId: string) => void;
    clearAllSecrets: () => void;

    // Base URL actions
    setProviderBaseURL: (providerId: string, baseURL: string) => void;
    getProviderBaseURL: (providerId: string) => string | undefined;
    clearProviderBaseURL: (providerId: string) => void;

    // Proxy actions
    setBackendProxyURL: (url: string | null) => void;
    getBackendProxyURL: () => string | null;
    isBackendProxyEnabled: () => boolean;

    // Computed helpers
    getAllProviders: () => ProviderInfo[];
    getProvider: (idOrAlias: string) => ProviderInfo | undefined;
    getCurrentProvider: () => ProviderInfo;
    getCurrentModelInfo: () => ModelInfo | undefined;
    getModelsForCurrentProvider: () => ModelInfo[];
    resolveModelId: (idOrAlias: string) => string | undefined;
    getAvailableModelIds: () => string[];
    getProvidersWithKeys: () => string[];

    // Legacy compatibility
    subscribeToChanges: (listener: ChangeListener) => () => void;
    _notifyLegacyListeners: () => void;
}

// ============================================================
// STORE IMPLEMENTATION
// ============================================================

export const useProviderStore = create<ProviderState>()(
    subscribeWithSelector((set, get) => ({
        // Initial state
        currentProviderId: DEFAULT_PROVIDER_ID,
        currentModelId: DEFAULT_MODEL_ID,
        customProviders: [],
        apiKeys: new Map(),
        baseURLOverrides: new Map(),
        backendProxyURL: null,
        legacyListeners: new Set(),

        // Provider selection
        setCurrentProvider: (idOrAlias: string) => {
            const provider = get().getProvider(idOrAlias);
            if (!provider) return false;

            if (get().currentProviderId !== provider.id) {
                set({
                    currentProviderId: provider.id,
                    currentModelId: provider.models[0]?.id || '',
                });
                get()._notifyLegacyListeners();
            }
            return true;
        },

        setCurrentModel: (idOrAlias: string) => {
            const resolvedId = get().resolveModelId(idOrAlias);
            if (!resolvedId) return false;

            if (get().currentModelId !== resolvedId) {
                set({ currentModelId: resolvedId });
                get()._notifyLegacyListeners();
            }
            return true;
        },

        setCustomModel: (modelId: string) => {
            set({ currentModelId: modelId });
            get()._notifyLegacyListeners();
        },

        addCustomProvider: (config) => {
            const provider: ProviderInfo = {
                id: config.id,
                name: config.name,
                type: 'openai',
                baseURL: config.baseURL,
                requiresKey: true,
                models: config.models || [],
                aliases: [],
            };
            set(state => ({
                customProviders: [...state.customProviders, provider],
            }));
            get()._notifyLegacyListeners();
            return provider;
        },

        removeCustomProvider: (id: string) => {
            const providers = get().customProviders;
            const filtered = providers.filter(p => p.id !== id);
            if (filtered.length === providers.length) return false;

            set({ customProviders: filtered });
            if (get().currentProviderId === id) {
                set({
                    currentProviderId: DEFAULT_PROVIDER_ID,
                    currentModelId: DEFAULT_MODEL_ID,
                });
            }
            get()._notifyLegacyListeners();
            return true;
        },

        // Secrets
        setApiKey: (providerId, apiKey) => {
            const keys = new Map(get().apiKeys);
            keys.set(`${providerId}:apiKey`, apiKey);
            set({ apiKeys: keys });
            get()._notifyLegacyListeners();
        },

        getApiKey: (providerId) => get().apiKeys.get(`${providerId}:apiKey`),

        hasApiKey: (providerId) => get().apiKeys.has(`${providerId}:apiKey`),

        removeApiKey: (providerId) => {
            const keys = new Map(get().apiKeys);
            keys.delete(`${providerId}:apiKey`);
            set({ apiKeys: keys });
            get()._notifyLegacyListeners();
        },

        clearAllSecrets: () => {
            set({ apiKeys: new Map() });
            get()._notifyLegacyListeners();
        },

        // Base URL
        setProviderBaseURL: (providerId, baseURL) => {
            const overrides = new Map(get().baseURLOverrides);
            overrides.set(providerId, baseURL.replace(/\/+$/, ''));
            set({ baseURLOverrides: overrides });
            get()._notifyLegacyListeners();
        },

        getProviderBaseURL: (providerId) => get().baseURLOverrides.get(providerId),

        clearProviderBaseURL: (providerId) => {
            const overrides = new Map(get().baseURLOverrides);
            overrides.delete(providerId);
            set({ baseURLOverrides: overrides });
            get()._notifyLegacyListeners();
        },

        // Proxy
        setBackendProxyURL: (url) => {
            set({ backendProxyURL: url });
            get()._notifyLegacyListeners();
        },

        getBackendProxyURL: () => get().backendProxyURL,

        isBackendProxyEnabled: () => get().backendProxyURL !== null,

        // Computed
        getAllProviders: () => [...BUILT_IN_PROVIDERS, ...get().customProviders],

        getProvider: (idOrAlias) => {
            const lower = idOrAlias.toLowerCase();
            return get().getAllProviders().find(p =>
                p.id === lower || p.aliases.some(a => a.toLowerCase() === lower)
            );
        },

        getCurrentProvider: () => {
            return get().getProvider(get().currentProviderId) || BUILT_IN_PROVIDERS[0];
        },

        getModelsForCurrentProvider: () => {
            return get().getCurrentProvider().models;
        },

        resolveModelId: (idOrAlias) => {
            const lower = idOrAlias.toLowerCase();
            const models = get().getModelsForCurrentProvider();
            const match = models.find(m =>
                m.id === idOrAlias ||
                m.id.toLowerCase() === lower ||
                m.aliases.some(a => a.toLowerCase() === lower)
            );
            return match?.id;
        },

        getCurrentModelInfo: () => {
            const modelId = get().currentModelId;
            return get().getModelsForCurrentProvider().find(m => m.id === modelId);
        },

        getAvailableModelIds: () => {
            const ids: string[] = [];
            for (const model of get().getModelsForCurrentProvider()) {
                ids.push(model.id);
                ids.push(...model.aliases);
            }
            return ids;
        },

        getProvidersWithKeys: () => {
            const providers: string[] = [];
            for (const key of get().apiKeys.keys()) {
                if (key.endsWith(':apiKey')) {
                    providers.push(key.replace(':apiKey', ''));
                }
            }
            return providers;
        },

        // Legacy compatibility
        subscribeToChanges: (listener) => {
            const listeners = get().legacyListeners;
            listeners.add(listener);
            set({ legacyListeners: new Set(listeners) });
            return () => {
                listeners.delete(listener);
                set({ legacyListeners: new Set(listeners) });
            };
        },

        _notifyLegacyListeners: () => {
            for (const listener of get().legacyListeners) {
                listener();
            }
        },
    }))
);

// ============================================================
// CONVENIENCE EXPORTS (for backward compatibility)
// ============================================================

export const getAllProviders = () => useProviderStore.getState().getAllProviders();
export const getProvider = (idOrAlias: string) => useProviderStore.getState().getProvider(idOrAlias);
export const getCurrentProvider = () => useProviderStore.getState().getCurrentProvider();
export const setCurrentProvider = (idOrAlias: string) => useProviderStore.getState().setCurrentProvider(idOrAlias);
export const getCurrentModel = () => useProviderStore.getState().currentModelId;
export const getCurrentModelInfo = () => useProviderStore.getState().getCurrentModelInfo();
export const setCurrentModel = (idOrAlias: string) => useProviderStore.getState().setCurrentModel(idOrAlias);
export const setCustomModel = (modelId: string) => useProviderStore.getState().setCustomModel(modelId);
export const addCustomProvider = (config: { id: string; name: string; baseURL: string; models?: ModelInfo[] }) => useProviderStore.getState().addCustomProvider(config);
export const removeCustomProvider = (id: string) => useProviderStore.getState().removeCustomProvider(id);
export const getModelsForCurrentProvider = () => useProviderStore.getState().getModelsForCurrentProvider();
export const resolveModelId = (idOrAlias: string) => useProviderStore.getState().resolveModelId(idOrAlias);
export const getAvailableModelIds = () => useProviderStore.getState().getAvailableModelIds();
export const setApiKey = (providerId: string, apiKey: string) => useProviderStore.getState().setApiKey(providerId, apiKey);
export const getApiKey = (providerId: string) => useProviderStore.getState().getApiKey(providerId);
export const hasApiKey = (providerId: string) => useProviderStore.getState().hasApiKey(providerId);
export const removeApiKey = (providerId: string) => useProviderStore.getState().removeApiKey(providerId);
export const clearApiKey = removeApiKey;
export const clearAllSecrets = () => useProviderStore.getState().clearAllSecrets();
export const getProvidersWithKeys = () => useProviderStore.getState().getProvidersWithKeys();
export const setProviderBaseURL = (providerId: string, baseURL: string) => useProviderStore.getState().setProviderBaseURL(providerId, baseURL);
export const getProviderBaseURL = (providerId: string) => useProviderStore.getState().getProviderBaseURL(providerId);
export const setBackendProxyURL = (url: string | null) => useProviderStore.getState().setBackendProxyURL(url);
export const getBackendProxyURL = () => useProviderStore.getState().getBackendProxyURL();
export const isBackendProxyEnabled = () => useProviderStore.getState().isBackendProxyEnabled();
export const subscribeToChanges = (listener: ChangeListener) => useProviderStore.getState().subscribeToChanges(listener);

// Effective base URL (override > default)
export const getEffectiveBaseURL = (providerId: string): string | undefined => {
    const override = getProviderBaseURL(providerId);
    if (override) return override;
    const provider = getProvider(providerId);
    return provider?.baseURL;
};

// Config summary for UI
export const getConfigSummary = () => {
    const provider = getCurrentProvider();
    return {
        provider,
        model: getCurrentModelInfo(),
        hasKey: hasApiKey(provider.id),
        usingProxy: isBackendProxyEnabled(),
    };
};
