/**
 * Built-in AI Providers
 * 
 * Default provider configurations for Anthropic and OpenAI.
 */

import type { ModelInfo, ProviderInfo } from './types';

// ============ Anthropic Models ============

export const ANTHROPIC_MODELS: ModelInfo[] = [
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

// ============ OpenAI Models ============

export const OPENAI_MODELS: ModelInfo[] = [
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

// ============ Built-in Providers ============

export const BUILT_IN_PROVIDERS: ProviderInfo[] = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        type: 'anthropic',
        baseURL: 'https://api.anthropic.com',
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

// ============ Default Values ============

export const DEFAULT_PROVIDER_ID = 'anthropic';
export const DEFAULT_MODEL_ID = 'claude-haiku-4-5-20251001';
