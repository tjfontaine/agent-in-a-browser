/**
 * Command Definition Types
 * 
 * Provides a clean API for defining commands with metadata,
 * completions, and handlers in separate files.
 */

// Output function type
export type OutputFn = (
    type: 'text' | 'tool-start' | 'tool-result' | 'error' | 'system',
    content: string,
    color?: string
) => void;

// Command context provided to handlers
export interface CommandContext {
    output: OutputFn;
    clearHistory: () => void;
    sendMessage: (msg: string) => void;
}

// Command handler function type
export type CommandHandler = (
    ctx: CommandContext,
    args: string[],
    options: Record<string, string | boolean>
) => Promise<void> | void;

// Subcommand definition
export interface SubcommandDef {
    name: string;
    description: string;
    usage?: string;
    handler: CommandHandler;
}

// Full command definition
export interface CommandDef {
    name: string;
    description: string;
    usage?: string;
    aliases?: string[];
    subcommands?: SubcommandDef[];
    completions?: (partial: string, args: string[]) => string[];
    handler: CommandHandler;
}

// Colors for output (shared)
export const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#ff7b72',
    magenta: '#bc8cff',
    dim: '#8b949e',
};
