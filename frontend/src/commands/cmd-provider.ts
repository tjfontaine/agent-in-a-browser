/**
 * /provider Command
 * 
 * View and switch AI providers.
 * 
 * Usage:
 *   /provider           - Show interactive provider picker
 *   /provider <id>      - Switch to a provider
 *   /provider list      - List all providers
 *   /provider add       - Add custom OpenAI-compatible endpoint
 */

import { CommandDef, CommandContext, colors } from './types';
import {
    getAllProviders,
    getCurrentProvider,
    setCurrentProvider,
    hasApiKey,
} from '../provider-config';

/**
 * Display provider status
 */
function showProviderStatus(ctx: CommandContext): void {
    const current = getCurrentProvider();
    const providers = getAllProviders();

    ctx.output('system', '', undefined);
    ctx.output('system', '┌─ AI Providers ───────────────────────────────┐', colors.cyan);
    ctx.output('system', `│ Current: ${current.name} (${current.aliases[0]})`, colors.cyan);
    ctx.output('system', '│', colors.cyan);

    for (const provider of providers) {
        const isCurrent = provider.id === current.id;
        const indicator = isCurrent ? '●' : '○';
        const keyStatus = hasApiKey(provider.id) ? '🔑' : (provider.requiresKey ? '⚠️' : '');
        const color = isCurrent ? colors.green : colors.dim;

        ctx.output('system', `│   ${indicator} ${provider.name} (${provider.aliases.join(', ')}) ${keyStatus}`, color);
        ctx.output('system', `│       ${provider.models.length} models available`, colors.dim);
    }

    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Usage: /provider to configure or switch', colors.dim);
    ctx.output('system', '└──────────────────────────────────────────────', colors.cyan);
    ctx.output('system', '', undefined);
}

/**
 * Switch to a provider
 */
function switchProvider(ctx: CommandContext, idOrAlias: string): void {
    if (setCurrentProvider(idOrAlias)) {
        const provider = getCurrentProvider();
        ctx.output('system', '', undefined);
        ctx.output('system', `✓ Switched to ${provider.name}`, colors.green);

        if (provider.requiresKey && !hasApiKey(provider.id)) {
            ctx.output('system', `⚠️ No API key set. Run /provider and press [k]`, colors.yellow);
        }
        ctx.output('system', '', undefined);
    } else {
        ctx.output('error', `Unknown provider: ${idOrAlias}`, colors.red);
        ctx.output('system', 'Use /provider list to see available providers', colors.dim);
    }
}

export const providerCommand: CommandDef = {
    name: 'provider',
    description: 'View or switch AI provider',
    usage: '/provider [provider-id]',
    aliases: ['p'],

    subcommands: [
        {
            name: 'list',
            description: 'List all providers',
            handler: async (ctx: CommandContext) => {
                showProviderStatus(ctx);
            },
        },
    ],

    // Tab completion for provider IDs
    completions: (partial: string): string[] => {
        const providers = getAllProviders();
        const ids: string[] = [];
        for (const p of providers) {
            ids.push(p.id);
            ids.push(...p.aliases);
        }

        if (!partial) {
            return ids.map(id => `/provider ${id}`);
        }
        return ids
            .filter(id => id.toLowerCase().startsWith(partial.toLowerCase()))
            .map(id => `/provider ${id}`);
    },

    handler: async (ctx: CommandContext, args: string[]) => {
        const idOrAlias = args[0];

        if (!idOrAlias || idOrAlias === 'list') {
            showProviderStatus(ctx);
        } else {
            switchProvider(ctx, idOrAlias);
        }
    },
};
