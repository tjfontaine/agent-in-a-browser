/**
 * Command Registry
 * 
 * Central registry that loads all command definitions and provides
 * execute and completion functionality.
 */

import { parseSlashCommand } from '../command-parser';
import { CommandDef, CommandContext, colors } from './types';

// Import all command definitions
import { helpCommand } from './cmd-help';
import { clearCommand } from './cmd-clear';
import { filesCommand } from './cmd-files';
import { mcpCommand } from './cmd-mcp';

// Registry of all commands
const registry: Map<string, CommandDef> = new Map();

// Register a command definition
export function registerCommand(cmd: CommandDef): void {
    registry.set(cmd.name, cmd);

    // Also register aliases
    if (cmd.aliases) {
        for (const alias of cmd.aliases) {
            registry.set(alias, cmd);
        }
    }
}

// Get all registered command names (for help)
export function getRegisteredCommands(): CommandDef[] {
    // Return unique commands (filter out aliases)
    const seen = new Set<CommandDef>();
    const result: CommandDef[] = [];
    for (const cmd of registry.values()) {
        if (!seen.has(cmd)) {
            seen.add(cmd);
            result.push(cmd);
        }
    }
    return result;
}

// Get completions for partial input
export function getCommandCompletions(input: string): string[] {
    if (!input.startsWith('/')) return [];

    const partial = input.slice(1);
    const parts = partial.split(/\s+/);
    const cmdName = parts[0]?.toLowerCase() || '';

    // Completing command name
    if (parts.length === 1 && !partial.endsWith(' ')) {
        const matching: string[] = [];
        const seen = new Set<string>();

        for (const [, cmd] of registry) {
            // Only suggest primary names, not aliases
            if (!seen.has(cmd.name) && cmd.name.startsWith(cmdName)) {
                matching.push(`/${cmd.name}`);
                seen.add(cmd.name);
            }
        }
        return matching;
    }

    // Check if command has custom completions
    const cmd = registry.get(cmdName);
    if (cmd?.completions) {
        return cmd.completions(parts[parts.length - 1] || '', parts.slice(1));
    }

    // Complete subcommands
    if (cmd?.subcommands && parts.length === 2) {
        const subPartial = parts[1] || '';
        return cmd.subcommands
            .filter(sub => sub.name.startsWith(subPartial))
            .map(sub => `/${cmdName} ${sub.name}`);
    }

    return [];
}

// Execute a slash command
export async function executeCommand(
    input: string,
    ctx: CommandContext
): Promise<boolean> {
    const parsed = parseSlashCommand(input);

    if (!parsed) {
        ctx.output('error', 'Invalid command format', colors.red);
        return true;
    }

    const { command, subcommand, args, options } = parsed;

    const cmd = registry.get(command);
    if (!cmd) {
        ctx.output('error', `Unknown command: /${command}`, colors.red);
        ctx.output('system', 'Type /help for available commands', colors.dim);
        return true;
    }

    try {
        // Check for subcommand
        if (subcommand && cmd.subcommands) {
            const sub = cmd.subcommands.find(s => s.name === subcommand);
            if (sub) {
                await sub.handler(ctx, args, options);
                return true;
            }
        }

        // Use main handler (with subcommand as first arg if present)
        const fullArgs = subcommand ? [subcommand, ...args] : args;
        await cmd.handler(ctx, fullArgs, options);
    } catch (e) {
        ctx.output('error', `Command error: ${e instanceof Error ? e.message : String(e)}`, colors.red);
    }

    return true;
}

// ============ Initialize Registry ============

// Register all built-in commands
registerCommand(helpCommand);
registerCommand(clearCommand);
registerCommand(filesCommand);
registerCommand(mcpCommand);

// Re-export types for convenience
export type { CommandDef, CommandContext, OutputFn } from './types';
export { colors } from './types';
