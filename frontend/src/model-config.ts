/**
 * Model Configuration
 * 
 * Central configuration for the AI model used by the agent.
 * Allows runtime switching between different Claude models.
 * 
 * Note: The @ai-sdk/anthropic provider doesn't expose a model list API,
 * so we maintain a curated list of commonly used models here.
 * See: https://docs.anthropic.com/en/docs/about-claude/models
 */

// Available models
export interface ModelInfo {
    id: string;
    name: string;
    description: string;
    aliases: string[];  // Short names like 'sonnet', 'haiku', 'opus'
}

export const AVAILABLE_MODELS: ModelInfo[] = [
    {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: 'Balanced performance and cost',
        aliases: ['sonnet', 's'],
    },
    {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'Fastest, lowest cost (default)',
        aliases: ['haiku', 'h'],
    },
    {
        id: 'claude-opus-4-5-20250514',
        name: 'Claude Opus 4.5',
        description: 'Highest capability',
        aliases: ['opus', 'o'],
    },
];

// Current model state
let currentModelId: string = 'claude-haiku-4-5-20251001';
const listeners: Set<(modelId: string) => void> = new Set();

/**
 * Resolve a model ID or alias to the canonical model ID
 */
export function resolveModelId(idOrAlias: string): string | undefined {
    const lower = idOrAlias.toLowerCase();

    // Check exact ID match first
    const exactMatch = AVAILABLE_MODELS.find(m => m.id === lower || m.id === idOrAlias);
    if (exactMatch) return exactMatch.id;

    // Check aliases
    const aliasMatch = AVAILABLE_MODELS.find(m =>
        m.aliases.some(a => a.toLowerCase() === lower)
    );
    if (aliasMatch) return aliasMatch.id;

    return undefined;
}

/**
 * Get the current model ID
 */
export function getCurrentModel(): string {
    return currentModelId;
}

/**
 * Get the current model info
 */
export function getCurrentModelInfo(): ModelInfo | undefined {
    return AVAILABLE_MODELS.find(m => m.id === currentModelId);
}

/**
 * Set the current model (accepts ID or alias)
 * @returns true if the model was changed, false if it was invalid
 */
export function setCurrentModel(idOrAlias: string): boolean {
    const resolvedId = resolveModelId(idOrAlias);
    if (!resolvedId) {
        return false;
    }

    if (currentModelId !== resolvedId) {
        currentModelId = resolvedId;
        // Notify all listeners
        for (const listener of listeners) {
            listener(resolvedId);
        }
    }
    return true;
}

/**
 * Subscribe to model changes
 * @returns unsubscribe function
 */
export function subscribeToModelChanges(listener: (modelId: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Get available model IDs and aliases (for completions)
 */
export function getAvailableModelIds(): string[] {
    const ids: string[] = [];
    for (const model of AVAILABLE_MODELS) {
        ids.push(model.id);
        ids.push(...model.aliases);
    }
    return ids;
}

