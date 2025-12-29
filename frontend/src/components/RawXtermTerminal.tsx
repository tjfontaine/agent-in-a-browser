/**
 * RawXtermTerminal - Direct xterm.js terminal for interactive TUI apps
 * 
 * Replaces ink-web when in interactive mode.
 * Writes directly to xterm.js for proper ANSI escape code handling.
 */
import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { keyEventToBytes } from '../wasm/interactive-process-bridge.js';
import type { InteractiveProcessBridge } from '../wasm/interactive-process-bridge.js';
import '@xterm/xterm/css/xterm.css';

export interface RawXtermTerminalHandle {
    write: (text: string) => void;
    focus: () => void;
}

interface RawXtermTerminalProps {
    bridge: InteractiveProcessBridge | null;
    onReady?: (write: (text: string) => void) => void;
    onExit?: () => void;
}

export const RawXtermTerminal = forwardRef<RawXtermTerminalHandle, RawXtermTerminalProps>(
    function RawXtermTerminal({ bridge, onReady, onExit: _onExit }, ref) {
        const containerRef = useRef<HTMLDivElement>(null);
        const terminalRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);

        // Expose write function via ref
        useImperativeHandle(ref, () => ({
            write: (text: string) => {
                terminalRef.current?.write(text);
            },
            focus: () => {
                terminalRef.current?.focus();
            },
        }), []);

        // Initialize terminal
        useEffect(() => {
            if (!containerRef.current) return;

            // Create terminal with matching theme
            const term = new Terminal({
                cursorBlink: true,
                fontSize: 14,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                theme: {
                    background: '#0d1117',
                    foreground: '#e6edf3',
                    cursor: '#39c5cf',
                    cursorAccent: '#0d1117',
                    selectionBackground: '#264f78',
                    black: '#484f58',
                    red: '#ff7b72',
                    green: '#3fb950',
                    yellow: '#d29922',
                    blue: '#58a6ff',
                    magenta: '#bc8cff',
                    cyan: '#39c5cf',
                    white: '#b1bac4',
                    brightBlack: '#6e7681',
                    brightRed: '#ffa198',
                    brightGreen: '#56d364',
                    brightYellow: '#e3b341',
                    brightBlue: '#79c0ff',
                    brightMagenta: '#d2a8ff',
                    brightCyan: '#56d4dd',
                    brightWhite: '#f0f6fc',
                },
            });

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);

            term.open(containerRef.current);
            fitAddon.fit();
            term.focus();

            terminalRef.current = term;
            fitAddonRef.current = fitAddon;

            // Notify parent of write function
            if (onReady) {
                onReady((text: string) => term.write(text));
            }

            // Handle resize
            const handleResize = () => {
                fitAddon.fit();
                if (bridge) {
                    bridge.resize(term.cols, term.rows);
                }
            };
            window.addEventListener('resize', handleResize);

            // Initial resize
            if (bridge) {
                bridge.resize(term.cols, term.rows);
            }

            return () => {
                window.removeEventListener('resize', handleResize);
                term.dispose();
                terminalRef.current = null;
            };
        }, [bridge, onReady]);

        // Handle keyboard input
        const handleKeyDown = useCallback((event: KeyboardEvent) => {
            if (!bridge) return;

            // Ctrl+D to signal EOF
            if (event.ctrlKey && event.key === 'd') {
                event.preventDefault();
                bridge.write(new Uint8Array([0x04]));
                return;
            }

            const bytes = keyEventToBytes(event);
            if (bytes) {
                event.preventDefault();
                event.stopPropagation();
                bridge.write(bytes);
            }
        }, [bridge]);

        // Attach keyboard handler
        useEffect(() => {
            if (!bridge) return;
            window.addEventListener('keydown', handleKeyDown, true);
            return () => {
                window.removeEventListener('keydown', handleKeyDown, true);
            };
        }, [handleKeyDown, bridge]);

        return (
            <div
                ref={containerRef}
                style={{
                    width: '100%',
                    height: '100%',
                    backgroundColor: '#0d1117',
                }}
            />
        );
    }
);
