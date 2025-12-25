/**
 * Slash Command Parser
 * 
 * Parses slash commands with subcommands and arguments.
 * Supports: /command subcommand arg1 arg2 --flag value
 */

export interface ParsedCommand {
    /** The main command without the leading slash */
    command: string;
    /** Subcommand (first positional arg after command) */
    subcommand: string | null;
    /** Positional arguments (after subcommand) */
    args: string[];
    /** Named options (--key value or --flag) */
    options: Record<string, string | boolean>;
    /** The original input string */
    raw: string;
}

/**
 * Parse a slash command string into structured components.
 * 
 * @example
 * parseSlashCommand('/mcp add https://example.com --name "My Server"')
 * // Returns:
 * // {
 * //   command: 'mcp',
 * //   subcommand: 'add',
 * //   args: ['https://example.com'],
 * //   options: { name: 'My Server' },
 * //   raw: '/mcp add https://example.com --name "My Server"'
 * // }
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
    const trimmed = input.trim();

    // Must start with /
    if (!trimmed.startsWith('/')) {
        return null;
    }

    // Tokenize respecting quotes
    const tokens = tokenize(trimmed.slice(1)); // Remove leading /

    if (tokens.length === 0) {
        return null;
    }

    const command = tokens[0].toLowerCase();
    const remaining = tokens.slice(1);

    // Parse options (--key value or --flag)
    const options: Record<string, string | boolean> = {};
    const positional: string[] = [];

    let i = 0;
    while (i < remaining.length) {
        const token = remaining[i];

        if (token.startsWith('--')) {
            const key = token.slice(2);
            // Check if next token is a value (not another flag)
            if (i + 1 < remaining.length && !remaining[i + 1].startsWith('--')) {
                options[key] = remaining[i + 1];
                i += 2;
            } else {
                // Boolean flag
                options[key] = true;
                i += 1;
            }
        } else if (token.startsWith('-') && token.length === 2) {
            // Short flag like -f
            const key = token.slice(1);
            if (i + 1 < remaining.length && !remaining[i + 1].startsWith('-')) {
                options[key] = remaining[i + 1];
                i += 2;
            } else {
                options[key] = true;
                i += 1;
            }
        } else {
            positional.push(token);
            i += 1;
        }
    }

    return {
        command,
        subcommand: positional.length > 0 ? positional[0] : null,
        args: positional.slice(1),
        options,
        raw: input,
    };
}

/**
 * Tokenize a string respecting quoted sections.
 */
function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (inQuote) {
            if (char === quoteChar) {
                // End quote
                inQuote = false;
                if (current) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            // Start quote
            inQuote = true;
            quoteChar = char;
        } else if (/\s/.test(char)) {
            // Whitespace - end current token
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    // Push final token
    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Command definition for validation
 */
export interface CommandDef {
    /** Subcommands this command accepts */
    subcommands?: string[];
    /** Required arguments (by position) */
    requiredArgs?: number;
    /** Optional arguments description */
    argNames?: string[];
}

/**
 * Command registry for validation and help
 */
export const COMMANDS: Record<string, CommandDef> = {
    clear: {},
    files: {},
    help: {},
    mcp: {
        subcommands: ['add', 'remove', 'auth', 'connect', 'disconnect', 'list'],
        argNames: ['url', 'id', 'clientId'],
    },
};

/**
 * Get usage string for a command
 */
export function getCommandUsage(command: string): string | null {
    const def = COMMANDS[command];
    if (!def) return null;

    if (def.subcommands) {
        return `/${command} <${def.subcommands.join('|')}>`;
    }
    return `/${command}`;
}
