/**
 * Shell History Management
 * 
 * Manages unified shell command history that includes:
 * - Commands typed directly in shell mode
 * - Commands executed via shell_eval by the agent
 * 
 * This enables users to navigate and replay/modify agent-executed commands.
 */

/**
 * A single entry in the shell history
 */
export interface ShellHistoryEntry {
    /** The command that was executed */
    command: string;
    /** When the command was executed */
    timestamp: number;
    /** Where the command originated from */
    source: 'user' | 'agent';
    /** Optional output from the command */
    output?: string;
}

/**
 * Maximum number of history entries to retain
 */
const MAX_HISTORY_SIZE = 500;

/**
 * Shell history manager with cursor navigation
 */
class ShellHistory {
    private entries: ShellHistoryEntry[] = [];
    private cursor: number = -1;
    private pendingInput: string = '';  // Store current input when navigating

    /**
     * Add a command to the history
     */
    add(command: string, source: 'user' | 'agent', output?: string): void {
        // Don't add empty commands
        if (!command.trim()) return;

        // Don't add duplicate of the most recent command
        if (this.entries.length > 0 &&
            this.entries[this.entries.length - 1].command === command) {
            return;
        }

        this.entries.push({
            command,
            timestamp: Date.now(),
            source,
            output,
        });

        // Trim to max size
        if (this.entries.length > MAX_HISTORY_SIZE) {
            this.entries = this.entries.slice(-MAX_HISTORY_SIZE);
        }

        // Reset cursor when new command is added
        this.resetCursor();
    }

    /**
     * Navigate up (older) in history
     * @param currentInput - Current input to store when starting navigation
     * @returns The previous command, or undefined if at the beginning
     */
    navigateUp(currentInput?: string): string | undefined {
        if (this.entries.length === 0) return undefined;

        // If starting navigation, store current input
        if (this.cursor === -1 && currentInput !== undefined) {
            this.pendingInput = currentInput;
        }

        // Move cursor up (towards older entries)
        if (this.cursor === -1) {
            // Start from the end
            this.cursor = this.entries.length - 1;
        } else if (this.cursor > 0) {
            this.cursor--;
        }

        return this.entries[this.cursor]?.command;
    }

    /**
     * Navigate down (newer) in history
     * @returns The next command, the pending input, or undefined
     */
    navigateDown(): string | undefined {
        if (this.cursor === -1) return undefined;

        this.cursor++;

        if (this.cursor >= this.entries.length) {
            // Past the end - return to pending input
            this.cursor = -1;
            return this.pendingInput;
        }

        return this.entries[this.cursor]?.command;
    }

    /**
     * Reset cursor to indicate not navigating
     */
    resetCursor(): void {
        this.cursor = -1;
        this.pendingInput = '';
    }

    /**
     * Get all history entries
     */
    getAll(): ShellHistoryEntry[] {
        return [...this.entries];
    }

    /**
     * Get history entries from a specific source
     */
    getBySource(source: 'user' | 'agent'): ShellHistoryEntry[] {
        return this.entries.filter(e => e.source === source);
    }

    /**
     * Clear all history
     */
    clear(): void {
        this.entries = [];
        this.resetCursor();
    }

    /**
     * Get the number of entries
     */
    get length(): number {
        return this.entries.length;
    }
}

/**
 * Singleton shell history instance
 */
export const shellHistory = new ShellHistory();
