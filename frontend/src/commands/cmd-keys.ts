/**
 * /keys Command
 * 
 * Manage API keys for providers (stored in memory only).
 * 
 * Usage:
 *   /keys              - List providers with stored keys
 *   /keys add <id>     - Add API key for a provider (shows secure input)
 *   /keys remove <id>  - Remove stored key
 *   /keys clear        - Clear all stored keys
 */

import { CommandDef, CommandContext, colors } from './types';
import {
    getAllProviders,
    getProvider,
    getProvidersWithKeys,
    hasApiKey,
    removeApiKey,
    clearAllSecrets,
} from '../provider-config';

/**
 * Display key status
 */
function showKeyStatus(ctx: CommandContext): void {
    const providers = getAllProviders();
    const withKeys = getProvidersWithKeys();

    ctx.output('system', '', undefined);
    ctx.output('system', '┌─ API Keys (Memory Only) ────────────────────┐', colors.cyan);
    ctx.output('system', '│ Keys are not persisted and will be lost on  │', colors.dim);
    ctx.output('system', '│ page refresh for security.                  │', colors.dim);
    ctx.output('system', '│', colors.cyan);

    if (withKeys.length === 0) {
        ctx.output('system', '│ No API keys stored.', colors.dim);
    } else {
        ctx.output('system', '│ Stored keys:', colors.cyan);
        for (const providerId of withKeys) {
            const provider = getProvider(providerId);
            ctx.output('system', `│   🔑 ${provider?.name || providerId}`, colors.green);
        }
    }

    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Providers needing keys:', colors.cyan);
    for (const provider of providers) {
        if (provider.requiresKey && !hasApiKey(provider.id)) {
            ctx.output('system', `│   ⚠️  ${provider.name} (${provider.id})`, colors.yellow);
        }
    }

    ctx.output('system', '│', colors.cyan);
    ctx.output('system', '│ Usage: /keys add <provider>', colors.dim);
    ctx.output('system', '└──────────────────────────────────────────────', colors.cyan);
    ctx.output('system', '', undefined);
}

export const keysCommand: CommandDef = {
    name: 'keys',
    description: 'Manage API keys',
    usage: '/keys [add|remove|clear] [provider]',

    subcommands: [
        {
            name: 'add',
            description: 'Add API key for a provider',
            handler: async (ctx: CommandContext, args: string[]) => {
                const providerId = args[0];
                if (!providerId) {
                    ctx.output('error', 'Usage: /keys add <provider>', colors.red);
                    ctx.output('system', 'Example: /keys add openai', colors.dim);
                    return;
                }

                const provider = getProvider(providerId);
                if (!provider) {
                    ctx.output('error', `Unknown provider: ${providerId}`, colors.red);
                    return;
                }

                // Signal to App.tsx to show the SecretInput component
                ctx.output('system', `__SHOW_SECRET_INPUT__:${provider.id}:${provider.name}`, undefined);
            },
        },
        {
            name: 'remove',
            description: 'Remove stored API key',
            handler: async (ctx: CommandContext, args: string[]) => {
                const providerId = args[0];
                if (!providerId) {
                    ctx.output('error', 'Usage: /keys remove <provider>', colors.red);
                    return;
                }

                if (hasApiKey(providerId)) {
                    removeApiKey(providerId);
                    ctx.output('system', `✓ Removed API key for ${providerId}`, colors.green);
                } else {
                    ctx.output('system', `No key stored for ${providerId}`, colors.dim);
                }
            },
        },
        {
            name: 'clear',
            description: 'Clear all stored keys',
            handler: async (ctx: CommandContext) => {
                clearAllSecrets();
                ctx.output('system', '✓ All API keys cleared', colors.green);
            },
        },
    ],

    // Tab completion for provider IDs
    completions: (partial: string, args: string[]): string[] => {
        // After 'add' or 'remove', complete provider IDs
        if (args.length > 0 && (args[0] === 'add' || args[0] === 'remove')) {
            const providers = getAllProviders();
            return providers
                .filter(p => p.id.startsWith(partial.toLowerCase()))
                .map(p => `/keys ${args[0]} ${p.id}`);
        }

        // Complete subcommands
        const subs = ['add', 'remove', 'clear'];
        return subs
            .filter(s => s.startsWith(partial.toLowerCase()))
            .map(s => `/keys ${s}`);
    },

    handler: async (ctx: CommandContext, args: string[]) => {
        const subcommand = args[0];

        if (!subcommand) {
            showKeyStatus(ctx);
        } else if (subcommand !== 'add' && subcommand !== 'remove' && subcommand !== 'clear') {
            // Maybe they specified a provider directly
            const provider = getProvider(subcommand);
            if (provider) {
                ctx.output('system', `__SHOW_SECRET_INPUT__:${provider.id}:${provider.name}`, undefined);
            } else {
                ctx.output('error', `Unknown subcommand or provider: ${subcommand}`, colors.red);
                ctx.output('system', 'Usage: /keys add <provider>', colors.dim);
            }
        }
    },
};
