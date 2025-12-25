/**
 * Provider Configuration Types
 * 
 * Type definitions for AI providers and their models.
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
    baseURL?: string;
    requiresKey: boolean;
    models: ModelInfo[];
    aliases: string[];
}

export type ChangeListener = () => void;
