/**
 * /model Command
 * 
 * View and switch the AI model used by the agent.
 * 
 * Usage:
 *   /model           - Show current model and list available models
 *   /model <id>      - Switch to a different model
 *   /model list      - List all available models
 */

import { CommandDef, CommandContext, colors } from './types';
import {
    getCurrentModel,
    getCurrentModelInfo,
    setCurrentModel,
    AVAILABLE_MODELS,
    getAvailableModelIds,
} from '../model-config';

/**
 * Display the current model and available options
 */
function showModelStatus(ctx: CommandContext): void {
    const current = getCurrentModelInfo();
    const aliases = current?.aliases.join(', ') || '';

    ctx.output('system', '', undefined);
    ctx.output('system', '┌─ Model Configuration ───────────────────────┐', colors.cyan);
    ctx.output('system', `│ Current: ${current?.name || 'Unknown'}`, colors.cyan);
    ctx.output('system', `│ Alias:   ${aliases}`, colors.dim);
    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Available models:', colors.cyan);

    for (const model of AVAILABLE_MODELS) {
        const indicator = model.id === getCurrentModel() ? '●' : '○';
        const color = model.id === getCurrentModel() ? colors.green : colors.dim;
        const modelAliases = model.aliases.join(', ');
        ctx.output('system', `│   ${indicator} ${model.name} (${modelAliases})`, color);
        ctx.output('system', `│       ${model.description}`, colors.dim);
    }

    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Usage: /model or /model <alias>', colors.dim);
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
        for (const model of AVAILABLE_MODELS) {
            ctx.output('system', `  • ${model.id}`, colors.dim);
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
