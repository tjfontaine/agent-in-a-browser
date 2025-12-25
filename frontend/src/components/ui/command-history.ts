/**
 * Command History Hook
 * 
 * Manages persistent command history with localStorage.
 * Provides navigation and search through history.
 */

// History storage key
const HISTORY_STORAGE_KEY = 'web-agent-command-history';
const MAX_HISTORY = 1000;

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Load history from localStorage.
 */
export function loadHistory(): string[] {
    try {
        const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                return parsed.slice(-MAX_HISTORY);
            }
        }
    } catch {
        // Ignore errors, start fresh
    }
    return [];
}

/**
 * Save history to localStorage.
 */
export function saveHistory(history: string[]): void {
    try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
    } catch {
        // Ignore quota errors etc.
    }
}

// ============================================================
// SHARED STATE
// ============================================================

// Shared history across all inputs, loaded from localStorage
const commandHistory: string[] = loadHistory();

/**
 * Get the shared command history array.
 * This is a mutable reference shared across all inputs.
 */
export function getCommandHistory(): string[] {
    return commandHistory;
}

/**
 * Add a command to history and persist it.
 * Deduplicates against the last entry.
 */
export function addToHistory(command: string): void {
    if (!command.trim()) return;

    // Don't add duplicates at the end
    if (commandHistory[commandHistory.length - 1] === command) return;

    commandHistory.push(command);
    if (commandHistory.length > MAX_HISTORY) {
        commandHistory.shift();
    }
    saveHistory(commandHistory);
}

/**
 * Clear all command history.
 */
export function clearHistory(): void {
    commandHistory.length = 0;
    saveHistory(commandHistory);
}

// ============================================================
// SEARCH
// ============================================================

/**
 * Search backwards through history for a query.
 * Returns the matching command and its index, or null if not found.
 * 
 * @param query - The search string
 * @param startIndex - Start searching from this index (exclusive). 
 *                     Pass commandHistory.length to search from the end.
 */
export function searchHistory(
    query: string,
    startIndex?: number
): { match: string; index: number } | null {
    if (!query) return null;

    const start = startIndex !== undefined
        ? Math.min(startIndex - 1, commandHistory.length - 1)
        : commandHistory.length - 1;

    const lowerQuery = query.toLowerCase();

    for (let i = start; i >= 0; i--) {
        if (commandHistory[i].toLowerCase().includes(lowerQuery)) {
            return { match: commandHistory[i], index: i };
        }
    }

    return null;
}

// ============================================================
// CONSTANTS
// ============================================================

export { MAX_HISTORY };
