/**
 * Rotating Hints
 * 
 * Cycles through helpful hints while the user is at the prompt.
 * Provides discoverability for keyboard shortcuts and features.
 */

// Hints shown for idle prompt (not busy)
export const IDLE_HINTS = [
    'Type a message or /help...',
    'Ctrl+\\ to switch panels',
    'Press 1/2/3 in aux panel to switch tabs',
    '/panel to toggle auxiliary panel',
    'Up/Down for command history',
    'Ctrl+R for history search',
    'Tab to autocomplete commands',
    '/files to browse OPFS',
    '/clear to clear the screen',
];

// Hints shown when busy
export const BUSY_HINTS = [
    'Type to queue messages...',
    'ESC or Ctrl+C to cancel',
    'Ctrl+\\ to switch to aux panel',
];

/**
 * Get a hint by index, cycling through the array
 */
export function getHint(hints: string[], index: number): string {
    return hints[index % hints.length];
}

/**
 * Hook to cycle through hints at an interval
 */
import { useEffect, useState } from 'react';

export function useRotatingHints(hints: string[], intervalMs: number = 4000): string {
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setIndex(prev => (prev + 1) % hints.length);
        }, intervalMs);
        return () => clearInterval(interval);
    }, [hints, intervalMs]);

    return hints[index];
}
