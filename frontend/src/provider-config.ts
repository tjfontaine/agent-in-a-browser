/**
 * Provider Configuration
 * 
 * Central configuration for AI providers and their models.
 * Supports Anthropic, OpenAI, and OpenAI-compatible endpoints.
 * 
 * Secrets are stored in memory only (lost on refresh for security).
 */

// ============ Types ============

export interface ModelInfo {
    id: string;
    name: string;
    description: string;
    aliases: string[];
}

export interface ProviderInfo {
    id: string;
    name: string;
    type: 'anthropic' | 'openai';
    baseURL?: string;  // Optional custom endpoint
    requiresKey: boolean;
    models: ModelInfo[];
    aliases: string[];
}

// ============ Built-in Providers ============

const ANTHROPIC_MODELS: ModelInfo[] = [
    {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: 'Balanced performance and cost',
        aliases: ['sonnet', 's'],
    },
    {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'Fastest, lowest cost',
        aliases: ['haiku', 'h'],
    },
    {
        id: 'claude-opus-4-5-20250514',
        name: 'Claude Opus 4.5',
        description: 'Highest capability',
        aliases: ['opus', 'o'],
    },
];

const OPENAI_MODELS: ModelInfo[] = [
    {
        id: 'gpt-5.2',
        name: 'GPT 5.2',
        description: 'Latest flagship model',
        aliases: ['5.2', 'latest'],
    },
    {
        id: 'gpt-5.2-thinking',
        name: 'GPT 5.2 Thinking',
        description: 'Deep reasoning mode',
        aliases: ['5.2-thinking', 'thinking'],
    },
    {
        id: 'gpt-5.1',
        name: 'GPT 5.1',
        description: 'Previous flagship',
        aliases: ['5.1'],
    },
    {
        id: 'gpt-5.1-codex',
        name: 'GPT 5.1 Codex',
        description: 'Agentic coding model',
        aliases: ['codex'],
    },
    {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Multimodal',
        aliases: ['4o'],
    },
    {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'Fast and affordable',
        aliases: ['4o-mini', 'mini'],
    },
    {
        id: 'o1',
        name: 'o1',
        description: 'Advanced reasoning',
        aliases: ['o1'],
    },
    {
        id: 'o3-mini',
        name: 'o3 Mini',
        description: 'Fast reasoning',
        aliases: ['o3-mini'],
    },
];

export const BUILT_IN_PROVIDERS: ProviderInfo[] = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        type: 'anthropic',
        baseURL: 'https://api.anthropic.com',  // Direct API by default
        requiresKey: true,
        models: ANTHROPIC_MODELS,
        aliases: ['claude', 'c'],
    },
    {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        requiresKey: true,
        models: OPENAI_MODELS,
        aliases: ['gpt', 'o'],
    },
];

// ============ State ============

// Current provider and model
let currentProviderId: string = 'anthropic';
let currentModelId: string = 'claude-haiku-4-5-20251001';

// Custom providers (user-defined OpenAI-compatible endpoints)
const customProviders: ProviderInfo[] = [];

// In-memory secrets store (lost on refresh)
const secrets: Map<string, string> = new Map();

// Backend proxy URL - null means disabled (default: direct API calls)
let backendProxyURL: string | null = null;

// Listeners for changes
type ChangeListener = () => void;
const listeners: Set<ChangeListener> = new Set();

// ============ Notify ============

function notifyListeners(): void {
    for (const listener of listeners) {
        listener();
    }
}

// ============ Provider Functions ============

/**
 * Get all available providers (built-in + custom)
 */
export function getAllProviders(): ProviderInfo[] {
    return [...BUILT_IN_PROVIDERS, ...customProviders];
}

/**
 * Get a provider by ID or alias
 */
export function getProvider(idOrAlias: string): ProviderInfo | undefined {
    const lower = idOrAlias.toLowerCase();
    return getAllProviders().find(p =>
        p.id === lower || p.aliases.some(a => a.toLowerCase() === lower)
    );
}

/**
 * Get current provider
 */
export function getCurrentProvider(): ProviderInfo {
    return getProvider(currentProviderId) || BUILT_IN_PROVIDERS[0];
}

/**
 * Set current provider
 */
export function setCurrentProvider(idOrAlias: string): boolean {
    const provider = getProvider(idOrAlias);
    if (!provider) return false;

    if (currentProviderId !== provider.id) {
        currentProviderId = provider.id;
        // Reset to first model of new provider
        currentModelId = provider.models[0]?.id || '';
        notifyListeners();
    }
    return true;
}

/**
 * Add a custom provider (OpenAI-compatible endpoint)
 */
export function addCustomProvider(config: {
    id: string;
    name: string;
    baseURL: string;
    models?: ModelInfo[];
}): ProviderInfo {
    const provider: ProviderInfo = {
        id: config.id,
        name: config.name,
        type: 'openai',  // Custom providers use OpenAI format
        baseURL: config.baseURL,
        requiresKey: true,  // Assume key required (user can skip if not needed)
        models: config.models || [
            { id: 'default', name: 'Default Model', description: 'Default model', aliases: [] },
        ],
        aliases: [config.id],
    };
    customProviders.push(provider);
    notifyListeners();
    return provider;
}

/**
 * Remove a custom provider
 */
export function removeCustomProvider(id: string): boolean {
    const index = customProviders.findIndex(p => p.id === id);
    if (index >= 0) {
        customProviders.splice(index, 1);
        // Switch away if this was current
        if (currentProviderId === id) {
            currentProviderId = 'anthropic';
            currentModelId = ANTHROPIC_MODELS[0].id;
        }
        notifyListeners();
        return true;
    }
    return false;
}

// ============ Model Functions ============

// Import from model-discovery (lazy to avoid circular deps)
let getCachedModelsFn: ((providerId: string) => ModelInfo[]) | null = null;

/**
 * Set the cached models getter (called from model-discovery.ts)
 */
export function setModelCacheGetter(fn: (providerId: string) => ModelInfo[]): void {
    getCachedModelsFn = fn;
}

/**
 * Get models for current provider (cached if available, else defaults)
 */
export function getModelsForCurrentProvider(): ModelInfo[] {
    const providerId = currentProviderId;

    // Check for cached models first
    if (getCachedModelsFn) {
        const cached = getCachedModelsFn(providerId);
        if (cached.length > 0) {
            return cached;
        }
    }

    // Fall back to default models
    return getCurrentProvider().models;
}

/**
 * Resolve a model ID or alias for the current provider
 */
export function resolveModelId(idOrAlias: string): string | undefined {
    const lower = idOrAlias.toLowerCase();
    const models = getModelsForCurrentProvider();

    const match = models.find(m =>
        m.id === idOrAlias ||
        m.id.toLowerCase() === lower ||
        m.aliases.some(a => a.toLowerCase() === lower)
    );
    return match?.id;
}

/**
 * Get current model ID
 */
export function getCurrentModel(): string {
    return currentModelId;
}

/**
 * Get current model info
 */
export function getCurrentModelInfo(): ModelInfo | undefined {
    return getModelsForCurrentProvider().find(m => m.id === currentModelId);
}

/**
 * Set current model (for current provider)
 */
export function setCurrentModel(idOrAlias: string): boolean {
    const resolvedId = resolveModelId(idOrAlias);
    if (!resolvedId) return false;

    if (currentModelId !== resolvedId) {
        currentModelId = resolvedId;
        notifyListeners();
    }
    return true;
}

/**
 * Set a custom model ID directly (bypasses validation)
 * Use for new/unlisted models
 */
export function setCustomModel(modelId: string): void {
    currentModelId = modelId;
    notifyListeners();
}

/**
 * Get available model IDs and aliases for completions
 */
export function getAvailableModelIds(): string[] {
    const ids: string[] = [];
    for (const model of getModelsForCurrentProvider()) {
        ids.push(model.id);
        ids.push(...model.aliases);
    }
    return ids;
}

// ============ Secrets Functions (Memory-Only) ============

/**
 * Set an API key for a provider (memory only)
 */
export function setApiKey(providerId: string, apiKey: string): void {
    secrets.set(`apikey:${providerId}`, apiKey);
    notifyListeners();
}

/**
 * Get an API key for a provider
 */
export function getApiKey(providerId: string): string | undefined {
    return secrets.get(`apikey:${providerId}`);
}

/**
 * Check if a provider has an API key set
 */
export function hasApiKey(providerId: string): boolean {
    return secrets.has(`apikey:${providerId}`);
}

/**
 * Remove an API key
 */
export function removeApiKey(providerId: string): void {
    secrets.delete(`apikey:${providerId}`);
    notifyListeners();
}

/**
 * Clear/remove an API key (alias for removeApiKey)
 */
export function clearApiKey(providerId: string): void {
    removeApiKey(providerId);
}

/**
 * Get list of providers with stored keys
 */
export function getProvidersWithKeys(): string[] {
    const result: string[] = [];
    for (const key of secrets.keys()) {
        if (key.startsWith('apikey:')) {
            result.push(key.slice(7));
        }
    }
    return result;
}

/**
 * Clear all stored secrets
 */
export function clearAllSecrets(): void {
    secrets.clear();
    notifyListeners();
}

// ============ Provider Base URL Overrides ============

// Store for per-provider base URL overrides
const baseURLOverrides: Map<string, string> = new Map();

/**
 * Set a custom base URL for a provider (memory only)
 */
export function setProviderBaseURL(providerId: string, baseURL: string): void {
    if (baseURL) {
        baseURLOverrides.set(providerId, baseURL);
    } else {
        baseURLOverrides.delete(providerId);
    }
    notifyListeners();
}

/**
 * Get the base URL for a provider (override or default)
 */
export function getProviderBaseURL(providerId: string): string | undefined {
    return baseURLOverrides.get(providerId);
}

/**
 * Get the effective base URL for a provider (override > default > undefined)
 */
export function getEffectiveBaseURL(providerId: string): string | undefined {
    const override = baseURLOverrides.get(providerId);
    if (override) return override;

    const provider = getProvider(providerId);
    return provider?.baseURL;
}

// ============ Backend Proxy ============

/**
 * Set the backend proxy URL (null to disable)
 */
export function setBackendProxyURL(url: string | null): void {
    backendProxyURL = url;
    notifyListeners();
}

/**
 * Get the backend proxy URL
 */
export function getBackendProxyURL(): string | null {
    return backendProxyURL;
}

/**
 * Check if backend proxy is enabled
 */
export function isBackendProxyEnabled(): boolean {
    return backendProxyURL !== null;
}

// ============ Subscription ============

/**
 * Subscribe to configuration changes
 */
export function subscribeToChanges(listener: ChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ============ Config Summary ============

/**
 * Get current configuration summary (for display)
 */
export function getConfigSummary(): {
    provider: ProviderInfo;
    model: ModelInfo | undefined;
    hasKey: boolean;
    usingProxy: boolean;
} {
    const provider = getCurrentProvider();
    return {
        provider,
        model: getCurrentModelInfo(),
        hasKey: hasApiKey(provider.id),
        usingProxy: isBackendProxyEnabled() && provider.type === 'anthropic',
    };
}
