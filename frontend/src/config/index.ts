/**
 * Config Module Index
 * 
 * Re-exports all configuration types and utilities.
 */

// Types
export type { ModelInfo, ProviderInfo, ChangeListener } from './types';

// Built-in providers
export {
    ANTHROPIC_MODELS,
    OPENAI_MODELS,
    BUILT_IN_PROVIDERS,
    DEFAULT_PROVIDER_ID,
    DEFAULT_MODEL_ID,
} from './built-in-providers';

// Zustand store and actions (preferred)
export {
    useProviderStore,
    getAllProviders,
    getProvider,
    getCurrentProvider,
    setCurrentProvider,
    getCurrentModel,
    getCurrentModelInfo,
    setCurrentModel,
    setCustomModel,
    addCustomProvider,
    removeCustomProvider,
    getModelsForCurrentProvider,
    resolveModelId,
    getAvailableModelIds,
    setApiKey,
    getApiKey,
    hasApiKey,
    removeApiKey,
    clearApiKey,
    clearAllSecrets,
    getProvidersWithKeys,
    setProviderBaseURL,
    getProviderBaseURL,
    setBackendProxyURL,
    getBackendProxyURL,
    isBackendProxyEnabled,
    subscribeToChanges,
    getEffectiveBaseURL,
    getConfigSummary,
} from './provider-store';

// Legacy secrets store (deprecated - use provider-store instead)
export {
    subscribeToSecrets,
    clearProviderBaseURL,
} from './secrets-store';
