/**
 * /model Command
 * 
 * View and switch the AI model used by the agent.
 * 
 * Usage:
 *   /model              - Show current model and list available models
 *   /model <id>         - Switch to a different model
 *   /model list         - List all available models
 *   /model refresh      - Fetch latest models from provider API
 *   /model set <name>   - Use any model ID directly
 */

import { CommandDef, CommandContext, colors } from './types';
import {
    getCurrentModel,
    getCurrentModelInfo,
    setCurrentModel,
    setCustomModel,
    getModelsForCurrentProvider,
    getAvailableModelIds,
    getCurrentProvider,
    getApiKey,
} from '../provider-config';
import { refreshModels } from '../config/ModelDiscovery';

/**
 * Display the current model and available options
 */
function showModelStatus(ctx: CommandContext): void {
    const provider = getCurrentProvider();
    const current = getCurrentModelInfo();
    const aliases = current?.aliases.join(', ') || '';
    const models = getModelsForCurrentProvider();

    ctx.output('system', '', undefined);
    ctx.output('system', '┌─ Model Configuration ───────────────────────┐', colors.cyan);
    ctx.output('system', `│ Provider: ${provider.name}`, colors.cyan);
    ctx.output('system', `│ Model:    ${current?.name || 'Unknown'}`, colors.cyan);
    ctx.output('system', `│ Alias:    ${aliases}`, colors.dim);
    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Available models:', colors.cyan);

    for (const model of models) {
        const indicator = model.id === getCurrentModel() ? '●' : '○';
        const color = model.id === getCurrentModel() ? colors.green : colors.dim;
        const modelAliases = model.aliases.join(', ');
        ctx.output('system', `│   ${indicator} ${model.name} (${modelAliases})`, color);
        ctx.output('system', `│       ${model.description}`, colors.dim);
    }

    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Usage: /model <alias> to switch', colors.dim);
    ctx.output('system', '│        /model refresh to fetch from API', colors.dim);
    ctx.output('system', '│        /model set <name> for custom models', colors.dim);
    ctx.output('system', '└──────────────────────────────────────────────┘', colors.cyan);
    ctx.output('system', '', undefined);
}

/**
 * Switch to a different model
 */
function switchModel(ctx: CommandContext, modelId: string): void {
    const oldModel = getCurrentModelInfo();

    if (setCurrentModel(modelId)) {
        const newModel = getCurrentModelInfo();
        ctx.output('system', '', undefined);
        ctx.output('system', `✓ Switched model:`, colors.green);
        ctx.output('system', `  ${oldModel?.name || oldModel?.id} → ${newModel?.name}`, colors.cyan);
        ctx.output('system', `  ${newModel?.description}`, colors.dim);
        ctx.output('system', '', undefined);
        ctx.output('system', '⚠ Note: Model change applies to new messages only.', colors.yellow);
        ctx.output('system', '  Use /clear to start fresh with the new model.', colors.dim);
        ctx.output('system', '', undefined);
    } else {
        ctx.output('error', `Unknown model: ${modelId}`, colors.red);
        ctx.output('system', '', undefined);
        ctx.output('system', 'Available models:', colors.dim);
        for (const model of getModelsForCurrentProvider()) {
            ctx.output('system', `  • ${model.id} (${model.aliases.join(', ')})`, colors.dim);
        }
        ctx.output('system', '', undefined);
    }
}

export const modelCommand: CommandDef = {
    name: 'model',
    description: 'View or switch the AI model',
    usage: '/model [model-id]',

    subcommands: [
        {
            name: 'list',
            description: 'List all available models',
            handler: async (ctx: CommandContext) => {
                showModelStatus(ctx);
            },
        },
        {
            name: 'refresh',
            description: 'Fetch latest models from provider API',
            handler: async (ctx: CommandContext) => {
                const provider = getCurrentProvider();

                if (!getApiKey(provider.id)) {
                    ctx.output('error', `No API key set for ${provider.name}. Run /provider and press [k].`, colors.red);
                    return;
                }

                ctx.output('system', `Fetching models from ${provider.name}...`, colors.dim);

                try {
                    const models = await refreshModels(provider.id);
                    ctx.output('system', `✓ Found ${models.length} models:`, colors.green);
                    for (const model of models.slice(0, 10)) {
                        ctx.output('system', `  • ${model.id} - ${model.name}`, colors.dim);
                    }
                    if (models.length > 10) {
                        ctx.output('system', `  ... and ${models.length - 10} more`, colors.dim);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    ctx.output('error', `Failed to fetch models: ${msg}`, colors.red);
                }
            },
        },
        {
            name: 'set',
            description: 'Set a custom model ID',
            handler: async (ctx: CommandContext, args: string[]) => {
                const modelId = args[0];
                if (!modelId) {
                    ctx.output('error', 'Usage: /model set <model-id>', colors.red);
                    ctx.output('system', 'Example: /model set gpt-5.3-preview', colors.dim);
                    return;
                }

                setCustomModel(modelId);
                ctx.output('system', `✓ Model set to: ${modelId}`, colors.green);
                ctx.output('system', '⚠ Note: This bypasses validation. Make sure the model exists.', colors.yellow);
            },
        },
    ],

    // Tab completion for model IDs
    completions: (partial: string): string[] => {
        const models = getAvailableModelIds();
        if (!partial) {
            return models.map(m => `/model ${m}`);
        }
        return models
            .filter(m => m.startsWith(partial))
            .map(m => `/model ${m}`);
    },

    handler: async (ctx: CommandContext, args: string[]) => {
        const modelId = args[0];

        if (!modelId || modelId === 'list') {
            // Show current model and list available
            showModelStatus(ctx);
        } else {
            // Switch to specified model
            switchModel(ctx, modelId);
        }
    },
};
