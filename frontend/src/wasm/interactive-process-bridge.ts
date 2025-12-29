/**
 * Interactive Process Bridge
 *
 * High-level bridge for interactive TUI applications.
 * Wraps a LazyProcess and provides:
 * - 60fps stdout/stderr polling loop
 * - Keyboard event to terminal byte conversion
 * - Resize event handling
 * - Signal forwarding
 */

import type { LazyProcess, TerminalSize } from './module-loader-impl.js';

export interface InteractiveCallbacks {
    /** Called when stdout data is available */
    onStdout: (data: Uint8Array) => void;
    /** Called when stderr data is available */
    onStderr: (data: Uint8Array) => void;
    /** Called when the process exits */
    onExit: (exitCode: number) => void;
}

/**
 * Interactive Process Bridge
 *
 * Manages communication between the React frontend and a running
 * interactive WASM process. Polls for output at 60fps and forwards
 * keyboard input as terminal bytes.
 */
export class InteractiveProcessBridge {
    private process: LazyProcess | null = null;
    private pollInterval: number | null = null;
    private callbacks: InteractiveCallbacks;
    private attached = false;

    constructor(callbacks: InteractiveCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * Attach to a LazyProcess and start polling for output.
     */
    attach(process: LazyProcess): void {
        if (this.attached) {
            console.warn('[InteractiveBridge] Already attached to a process');
            return;
        }
        this.process = process;
        this.attached = true;
        this.startPolling();
        console.log('[InteractiveBridge] Attached to process');
    }

    /**
     * Write data to the process stdin.
     */
    write(data: Uint8Array | string): void {
        if (!this.process) {
            console.warn('[InteractiveBridge] write() called but no process attached');
            return;
        }
        const bytes = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
        this.process.writeStdin(bytes);
    }

    /**
     * Resize the terminal.
     */
    resize(cols: number, rows: number): void {
        if (!this.process) return;
        this.process.setTerminalSize({ cols, rows });
    }

    /**
     * Send a signal to the process.
     */
    signal(signum: number): void {
        if (!this.process) return;
        this.process.sendSignal(signum);
    }

    /**
     * Get current terminal size.
     */
    getSize(): TerminalSize | null {
        return this.process?.getTerminalSize() ?? null;
    }

    /**
     * Check if in raw mode.
     */
    isRawMode(): boolean {
        return this.process?.isRawMode() ?? false;
    }

    /**
     * Detach from the process and stop polling.
     */
    detach(): void {
        this.stopPolling();
        this.process = null;
        this.attached = false;
        console.log('[InteractiveBridge] Detached from process');
    }

    /**
     * Check if currently attached to a process.
     */
    isAttached(): boolean {
        return this.attached;
    }

    private startPolling(): void {
        // Poll at ~60fps for responsive TUI updates
        this.pollInterval = window.setInterval(() => {
            this.pollOutput();
        }, 16);
    }

    private stopPolling(): void {
        if (this.pollInterval !== null) {
            window.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async pollOutput(): Promise<void> {
        if (!this.process) return;

        // Read stdout (up to 8KB per poll)
        const stdout = this.process.readStdout(BigInt(8192));
        if (stdout.length > 0) {
            this.callbacks.onStdout(new Uint8Array(stdout));
        }

        // Read stderr (up to 1KB per poll)
        const stderr = this.process.readStderr(BigInt(1024));
        if (stderr.length > 0) {
            this.callbacks.onStderr(new Uint8Array(stderr));
        }

        // Check if process has exited
        const exitCode = await this.process.tryWait();
        if (exitCode !== undefined) {
            // Process has exited - drain any remaining output
            // This handles the case where output was written synchronously
            // before the polling loop started
            let drainStdout: Uint8Array;
            while ((drainStdout = this.process.readStdout(BigInt(8192))).length > 0) {
                this.callbacks.onStdout(new Uint8Array(drainStdout));
            }
            let drainStderr: Uint8Array;
            while ((drainStderr = this.process.readStderr(BigInt(1024))).length > 0) {
                this.callbacks.onStderr(new Uint8Array(drainStderr));
            }

            console.log(`[InteractiveBridge] Process exited with code ${exitCode}`);
            this.callbacks.onExit(exitCode);
            this.detach();
        }
    }
}

// ========== Keyboard Event Conversion ==========

/**
 * Convert a keyboard event to terminal bytes.
 *
 * Handles:
 * - Regular ASCII characters
 * - Control key combinations (Ctrl+A through Ctrl+Z)
 * - Special keys (Enter, Backspace, Tab, Escape)
 * - Arrow keys (as CSI escape sequences)
 * - Function keys (as CSI escape sequences)
 * - Home, End, Page Up, Page Down
 *
 * Returns null if the key should not be sent to the terminal.
 */
export function keyEventToBytes(event: KeyboardEvent): Uint8Array | null {
    // Don't handle events with meta key (Cmd on Mac) - let browser handle
    if (event.metaKey) {
        return null;
    }

    const { key, ctrlKey, altKey, shiftKey } = event;

    // Ctrl+key combinations
    if (ctrlKey && !altKey) {
        // Ctrl+letter -> control character
        if (key.length === 1 && /[a-zA-Z]/.test(key)) {
            const code = key.toUpperCase().charCodeAt(0) - 64; // A=1, B=2, ..., Z=26
            return new Uint8Array([code]);
        }
        // Ctrl+[ is Escape (27)
        if (key === '[') {
            return new Uint8Array([0x1B]);
        }
        // Ctrl+\ is FS (28)
        if (key === '\\') {
            return new Uint8Array([0x1C]);
        }
        // Ctrl+] is GS (29)
        if (key === ']') {
            return new Uint8Array([0x1D]);
        }
    }

    // Special keys
    switch (key) {
        case 'Enter':
            return new Uint8Array([0x0D]); // CR
        case 'Backspace':
            return new Uint8Array([0x7F]); // DEL
        case 'Tab':
            return shiftKey
                ? new Uint8Array([0x1B, 0x5B, 0x5A]) // CSI Z (Shift+Tab)
                : new Uint8Array([0x09]);            // HT
        case 'Escape':
            return new Uint8Array([0x1B]);
        case 'Delete':
            return new Uint8Array([0x1B, 0x5B, 0x33, 0x7E]); // CSI 3 ~

        // Arrow keys
        case 'ArrowUp':
            return new Uint8Array([0x1B, 0x5B, 0x41]); // CSI A
        case 'ArrowDown':
            return new Uint8Array([0x1B, 0x5B, 0x42]); // CSI B
        case 'ArrowRight':
            return new Uint8Array([0x1B, 0x5B, 0x43]); // CSI C
        case 'ArrowLeft':
            return new Uint8Array([0x1B, 0x5B, 0x44]); // CSI D

        // Navigation keys
        case 'Home':
            return new Uint8Array([0x1B, 0x5B, 0x48]); // CSI H
        case 'End':
            return new Uint8Array([0x1B, 0x5B, 0x46]); // CSI F
        case 'PageUp':
            return new Uint8Array([0x1B, 0x5B, 0x35, 0x7E]); // CSI 5 ~
        case 'PageDown':
            return new Uint8Array([0x1B, 0x5B, 0x36, 0x7E]); // CSI 6 ~
        case 'Insert':
            return new Uint8Array([0x1B, 0x5B, 0x32, 0x7E]); // CSI 2 ~

        // Function keys (F1-F12)
        case 'F1':
            return new Uint8Array([0x1B, 0x4F, 0x50]); // SS3 P
        case 'F2':
            return new Uint8Array([0x1B, 0x4F, 0x51]); // SS3 Q
        case 'F3':
            return new Uint8Array([0x1B, 0x4F, 0x52]); // SS3 R
        case 'F4':
            return new Uint8Array([0x1B, 0x4F, 0x53]); // SS3 S
        case 'F5':
            return new Uint8Array([0x1B, 0x5B, 0x31, 0x35, 0x7E]); // CSI 15 ~
        case 'F6':
            return new Uint8Array([0x1B, 0x5B, 0x31, 0x37, 0x7E]); // CSI 17 ~
        case 'F7':
            return new Uint8Array([0x1B, 0x5B, 0x31, 0x38, 0x7E]); // CSI 18 ~
        case 'F8':
            return new Uint8Array([0x1B, 0x5B, 0x31, 0x39, 0x7E]); // CSI 19 ~
        case 'F9':
            return new Uint8Array([0x1B, 0x5B, 0x32, 0x30, 0x7E]); // CSI 20 ~
        case 'F10':
            return new Uint8Array([0x1B, 0x5B, 0x32, 0x31, 0x7E]); // CSI 21 ~
        case 'F11':
            return new Uint8Array([0x1B, 0x5B, 0x32, 0x33, 0x7E]); // CSI 23 ~
        case 'F12':
            return new Uint8Array([0x1B, 0x5B, 0x32, 0x34, 0x7E]); // CSI 24 ~
    }

    // Regular printable characters
    if (key.length === 1 && !ctrlKey) {
        return new TextEncoder().encode(key);
    }

    // Alt+key (send as ESC + key)
    if (altKey && key.length === 1 && !ctrlKey) {
        const keyBytes = new TextEncoder().encode(key);
        const result = new Uint8Array(1 + keyBytes.length);
        result[0] = 0x1B;
        result.set(keyBytes, 1);
        return result;
    }

    // Unknown key - don't send
    return null;
}

/**
 * Creates a keyboard event handler for interactive mode.
 * Captures all keydown events and sends them to the process.
 */
export function createKeyboardHandler(bridge: InteractiveProcessBridge): (event: KeyboardEvent) => void {
    return (event: KeyboardEvent) => {
        const bytes = keyEventToBytes(event);
        if (bytes) {
            event.preventDefault();
            event.stopPropagation();
            bridge.write(bytes);
        }
    };
}
