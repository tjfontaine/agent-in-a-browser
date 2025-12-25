/**
 * Secrets Store
 * 
 * In-memory storage for API keys and sensitive data.
 * Lost on refresh for security - never persisted to storage.
 */

import type { ChangeListener } from './types';

// ============ State ============

// In-memory secrets store (lost on refresh)
const secrets: Map<string, string> = new Map();

// Per-provider base URL overrides
const baseURLOverrides: Map<string, string> = new Map();

// Backend proxy URL - null means disabled (default: direct API calls)
let backendProxyURL: string | null = null;

// Listeners for changes
const listeners: Set<ChangeListener> = new Set();

// ============ Notify ============

function notifyListeners(): void {
    for (const listener of listeners) {
        listener();
    }
}

// ============ API Keys ============

/**
 * Set an API key for a provider (memory only).
 */
export function setApiKey(providerId: string, apiKey: string): void {
    secrets.set(`${providerId}:apiKey`, apiKey);
    notifyListeners();
}

/**
 * Get an API key for a provider.
 */
export function getApiKey(providerId: string): string | undefined {
    return secrets.get(`${providerId}:apiKey`);
}

/**
 * Check if a provider has an API key set.
 */
export function hasApiKey(providerId: string): boolean {
    return secrets.has(`${providerId}:apiKey`);
}

/**
 * Remove an API key.
 */
export function removeApiKey(providerId: string): void {
    secrets.delete(`${providerId}:apiKey`);
    notifyListeners();
}

/**
 * Clear/remove an API key (alias for removeApiKey).
 */
export function clearApiKey(providerId: string): void {
    removeApiKey(providerId);
}

/**
 * Get list of providers with stored keys.
 */
export function getProvidersWithKeys(): string[] {
    const providers: string[] = [];
    for (const key of secrets.keys()) {
        if (key.endsWith(':apiKey')) {
            providers.push(key.replace(':apiKey', ''));
        }
    }
    return providers;
}

/**
 * Clear all stored secrets.
 */
export function clearAllSecrets(): void {
    secrets.clear();
    notifyListeners();
}

// ============ Base URL Overrides ============

/**
 * Set a custom base URL for a provider (memory only).
 */
export function setProviderBaseURL(providerId: string, baseURL: string): void {
    // Normalize: remove trailing slash
    const normalized = baseURL.replace(/\/+$/, '');
    baseURLOverrides.set(providerId, normalized);
    notifyListeners();
}

/**
 * Get the base URL override for a provider.
 */
export function getProviderBaseURL(providerId: string): string | undefined {
    return baseURLOverrides.get(providerId);
}

/**
 * Clear the base URL override for a provider.
 */
export function clearProviderBaseURL(providerId: string): void {
    baseURLOverrides.delete(providerId);
    notifyListeners();
}

// ============ Backend Proxy ============

/**
 * Set the backend proxy URL (null to disable).
 */
export function setBackendProxyURL(url: string | null): void {
    backendProxyURL = url;
    notifyListeners();
}

/**
 * Get the backend proxy URL.
 */
export function getBackendProxyURL(): string | null {
    return backendProxyURL;
}

/**
 * Check if backend proxy is enabled.
 */
export function isBackendProxyEnabled(): boolean {
    return backendProxyURL !== null;
}

// ============ Subscription ============

/**
 * Subscribe to secrets/configuration changes.
 * Returns unsubscribe function.
 */
export function subscribeToSecrets(listener: ChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
