/**
 * Terminal info WIT interface implementation
 * 
 * Provides terminal size information to the WASM TUI.
 */

import { getTerminalSize as getSize } from './ghostty-cli-shim.js';

/**
 * Get current terminal dimensions
 * 
 * This is called by the ratatui backend's size() method to get
 * the current terminal dimensions for proper layout.
 * 
 * @returns {{ cols: number, rows: number }} Terminal dimensions
 */
export function getTerminalSize() {
    const size = getSize();
    console.log('[terminal-info] getTerminalSize:', size.cols, 'x', size.rows);
    return size;
}
