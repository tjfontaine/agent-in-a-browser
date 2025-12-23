/**
 * Model Discovery
 * 
 * Fetches available models from provider APIs (OpenAI, Anthropic).
 * Results are cached in memory and can be refreshed on demand.
 */

import { getApiKey, getEffectiveBaseURL, setModelCacheGetter, type ModelInfo } from './provider-config';

// ============ Types ============

interface OpenAIModel {
    id: string;
    owned_by: string;
    created: number;
}

interface AnthropicModel {
    id: string;
    display_name: string;
    created_at: string;
}

interface ModelListResponse<T> {
    data: T[];
    has_more?: boolean;
}

// ============ Cache ============

// Cache discovered models per provider
const modelCache: Map<string, ModelInfo[]> = new Map();
const lastFetchTime: Map<string, number> = new Map();

// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

// Register cache getter with provider-config
setModelCacheGetter((providerId: string) => modelCache.get(providerId) || []);

// ============ Fetchers ============

/**
 * Fetch models from OpenAI API
 */
async function fetchOpenAIModels(apiKey: string, baseURL?: string): Promise<ModelInfo[]> {
    const url = baseURL
        ? `${baseURL.replace(/\/$/, '')}/models`
        : 'https://api.openai.com/v1/models';

    console.log('[ModelDiscovery] Fetching OpenAI models from:', url);

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data: ModelListResponse<OpenAIModel> = await response.json();

    // Filter to chat-capable models and sort by creation date (newest first)
    const chatModels = data.data
        .filter(m => isChatModel(m.id))
        .sort((a, b) => b.created - a.created);

    return chatModels.map(m => ({
        id: m.id,
        name: formatModelName(m.id),
        description: `Owned by ${m.owned_by}`,
        aliases: generateAliases(m.id),
    }));
}

/**
 * Fetch models from Anthropic API
 */
async function fetchAnthropicModels(apiKey: string, baseURL?: string): Promise<ModelInfo[]> {
    const url = baseURL
        ? `${baseURL.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`
        : 'https://api.anthropic.com/v1/models';

    console.log('[ModelDiscovery] Fetching Anthropic models from:', url);

    const response = await fetch(url, {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
    });

    if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data: ModelListResponse<AnthropicModel> = await response.json();

    // Sort by creation date (newest first)
    const sortedModels = data.data.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return sortedModels.map(m => ({
        id: m.id,
        name: m.display_name || formatModelName(m.id),
        description: 'Anthropic Claude model',
        aliases: generateAliases(m.id),
    }));
}

// ============ Helpers ============

/**
 * Check if a model ID is a chat/completion model (not embedding, etc.)
 */
function isChatModel(id: string): boolean {
    const lower = id.toLowerCase();

    // Exclude non-chat models
    if (lower.includes('embedding')) return false;
    if (lower.includes('whisper')) return false;
    if (lower.includes('tts')) return false;
    if (lower.includes('dall-e')) return false;
    if (lower.includes('moderation')) return false;

    // Include GPT, o1, o3, codex models
    if (lower.includes('gpt')) return true;
    if (lower.startsWith('o1')) return true;
    if (lower.startsWith('o3')) return true;
    if (lower.includes('codex')) return true;

    return false;
}

/**
 * Format a model ID into a human-readable name
 */
function formatModelName(id: string): string {
    return id
        .replace(/^gpt-/, 'GPT ')
        .replace(/-/g, ' ')
        .replace(/(\d+)\.(\d+)/g, '$1.$2')  // Keep version numbers
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Generate short aliases for a model ID
 */
function generateAliases(id: string): string[] {
    const aliases: string[] = [];
    const lower = id.toLowerCase();

    // GPT aliases
    if (lower.includes('gpt-5.2')) aliases.push('5.2');
    if (lower.includes('gpt-5.1')) aliases.push('5.1');
    if (lower.includes('gpt-4o-mini')) aliases.push('4o-mini', 'mini');
    else if (lower.includes('gpt-4o')) aliases.push('4o');

    // Reasoning model aliases
    if (lower === 'o1') aliases.push('o1');
    if (lower === 'o1-mini') aliases.push('o1-mini');
    if (lower === 'o3-mini') aliases.push('o3-mini');

    // Codex aliases
    if (lower.includes('codex')) aliases.push('codex');

    // Thinking mode aliases
    if (lower.includes('thinking')) aliases.push('thinking');

    // Claude aliases
    if (lower.includes('sonnet')) aliases.push('sonnet', 's');
    if (lower.includes('haiku')) aliases.push('haiku', 'h');
    if (lower.includes('opus')) aliases.push('opus', 'o');

    return aliases;
}

// ============ Public API ============

/**
 * Refresh models for a provider from its API
 * Returns the discovered models, or throws on error
 */
export async function refreshModels(providerId: string): Promise<ModelInfo[]> {
    const apiKey = getApiKey(providerId);
    if (!apiKey) {
        throw new Error(`No API key set for ${providerId}. Set one first with /provider.`);
    }

    const baseURL = getEffectiveBaseURL(providerId);

    let models: ModelInfo[];

    if (providerId === 'openai') {
        models = await fetchOpenAIModels(apiKey, baseURL);
    } else if (providerId === 'anthropic') {
        models = await fetchAnthropicModels(apiKey, baseURL);
    } else {
        // For custom providers, try OpenAI-compatible endpoint
        models = await fetchOpenAIModels(apiKey, baseURL);
    }

    // Cache the results
    modelCache.set(providerId, models);
    lastFetchTime.set(providerId, Date.now());

    console.log(`[ModelDiscovery] Cached ${models.length} models for ${providerId}`);

    return models;
}

/**
 * Get cached models for a provider (returns empty array if not cached)
 */
export function getCachedModels(providerId: string): ModelInfo[] {
    return modelCache.get(providerId) || [];
}

/**
 * Check if cached models are stale (older than TTL)
 */
export function isCacheStale(providerId: string): boolean {
    const lastFetch = lastFetchTime.get(providerId);
    if (!lastFetch) return true;
    return Date.now() - lastFetch > CACHE_TTL_MS;
}

/**
 * Clear cached models for a provider
 */
export function clearModelCache(providerId: string): void {
    modelCache.delete(providerId);
    lastFetchTime.delete(providerId);
}

/**
 * Background refresh - non-blocking, logs errors
 */
export function backgroundRefreshModels(providerId: string): void {
    refreshModels(providerId).catch(err => {
        console.warn(`[ModelDiscovery] Background refresh failed for ${providerId}:`, err.message);
    });
}
