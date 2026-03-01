/**
 * Terminal info WIT interface implementation
 *
 * Provides terminal size information to the WASM TUI.
 */

import { getTerminalSize as getSize } from './ghostty-cli-shim.js';

/**
 * Get current terminal dimensions.
 *
 * Called by the ratatui backend's size() method to get
 * the current terminal dimensions for proper layout.
 */
export function getTerminalSize(): { cols: number; rows: number } {
    return getSize();
}
