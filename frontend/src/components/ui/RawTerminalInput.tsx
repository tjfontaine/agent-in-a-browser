/**
 * RawTerminalInput - Unbuffered input handler for TUI applications
 *
 * Captures all keyboard events and sends them directly to the interactive
 * process via the bridge. Does not render anything visible - the TUI
 * application handles all rendering through ANSI codes to the terminal.
 */
import { useEffect, useCallback } from 'react';
import {
    InteractiveProcessBridge,
    createKeyboardHandler,
} from '../../wasm/interactive-process-bridge.js';

interface RawTerminalInputProps {
    /** The interactive process bridge to send keystrokes to */
    bridge: InteractiveProcessBridge;
    /** Whether this component should capture keyboard input */
    focus?: boolean;
    /** Optional callback when user requests exit (Ctrl+D when buffer empty) */
    onExitRequest?: () => void;
}

/**
 * Hook to handle raw terminal input.
 *
 * Attaches a keyboard event handler that captures all keystrokes
 * and sends them to the interactive process via the bridge.
 */
export function useRawTerminalInput(
    bridge: InteractiveProcessBridge | null,
    focus: boolean = true,
    onExitRequest?: () => void,
): void {
    const handleKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (!bridge || !focus) return;

            // Special handling for Ctrl+D (exit request)
            if (event.ctrlKey && event.key === 'd') {
                event.preventDefault();
                event.stopPropagation();
                onExitRequest?.();
                return;
            }

            // Use the bridge's keyboard handler
            const handler = createKeyboardHandler(bridge);
            handler(event);
        },
        [bridge, focus, onExitRequest]
    );

    useEffect(() => {
        if (!focus || !bridge) return;

        // Use capture phase to get events before other handlers
        window.addEventListener('keydown', handleKeyDown, true);

        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [focus, bridge, handleKeyDown]);
}

/**
 * RawTerminalInput component
 *
 * Renders nothing - just handles keyboard capture.
 * The TUI application renders directly to the terminal via ANSI codes.
 */
export function RawTerminalInput({
    bridge,
    focus = true,
    onExitRequest,
}: RawTerminalInputProps): null {
    useRawTerminalInput(bridge, focus, onExitRequest);
    return null;
}

export default RawTerminalInput;
