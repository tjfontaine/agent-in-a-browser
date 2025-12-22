/**
 * SplitLayout Component
 * 
 * Responsive split terminal layout:
 * - ≥800px: Vertical split (side by side)
 * - <800px: Horizontal split (stacked)
 * 
 * Aux panel toggled via /panel command (see commands/panel.ts)
 * Focus switching via Ctrl+\ (see App.tsx)
 */

import { useEffect, useRef, useState } from 'react';

const BREAKPOINT = 800;

interface SplitLayoutProps {
    auxiliaryPanel: React.ReactNode;
    mainPanel: React.ReactNode;
}

// Global state - used by /panel command and focus control
let _auxVisible = false;
let _setAuxVisible: ((v: boolean) => void) | null = null;
let _mainPanelRef: HTMLDivElement | null = null;
let _auxPanelRef: HTMLDivElement | null = null;
let _isAuxFocused = false;

export function toggleAuxPanel(): void {
    _setAuxVisible?.(!_auxVisible);
}

export function setAuxPanelVisible(visible: boolean): void {
    _setAuxVisible?.(visible);
}

export function isAuxPanelVisible(): boolean {
    return _auxVisible;
}

// Focus control functions for Ctrl+\ switching
export function focusAuxPanel(): void {
    if (_auxPanelRef && _auxVisible) {
        // Find the xterm canvas/textarea inside and focus it
        const focusable = _auxPanelRef.querySelector<HTMLElement>('.xterm-helper-textarea, textarea, input');
        if (focusable) {
            focusable.focus();
            _isAuxFocused = true;
        }
    }
}

export function focusMainPanel(): void {
    if (_mainPanelRef) {
        const focusable = _mainPanelRef.querySelector<HTMLElement>('.xterm-helper-textarea, textarea, input');
        if (focusable) {
            focusable.focus();
            _isAuxFocused = false;
        }
    }
}

export function isAuxFocused(): boolean {
    return _isAuxFocused;
}

// Toggle focus between panels
export function togglePanelFocus(): void {
    if (_isAuxFocused) {
        focusMainPanel();
    } else {
        focusAuxPanel();
    }
}

export function SplitLayout({ auxiliaryPanel, mainPanel }: SplitLayoutProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mainRef = useRef<HTMLDivElement>(null);
    const auxRef = useRef<HTMLDivElement>(null);
    const [isWide, setIsWide] = useState(true);
    const [auxVisible, setAuxVisible] = useState(false);

    // Register global control
    useEffect(() => {
        _setAuxVisible = (v: boolean) => {
            _auxVisible = v;
            setAuxVisible(v);
        };
        return () => { _setAuxVisible = null; };
    }, []);

    // Register panel refs for focus control
    useEffect(() => {
        _mainPanelRef = mainRef.current;
        _auxPanelRef = auxRef.current;
        return () => {
            _mainPanelRef = null;
            _auxPanelRef = null;
        };
    }, [auxVisible]); // Re-register when aux visibility changes

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const checkWidth = () => {
            setIsWide(container.clientWidth >= BREAKPOINT);
        };

        // Initial check
        checkWidth();

        // Observe size changes
        const ro = new ResizeObserver(checkWidth);
        ro.observe(container);

        return () => ro.disconnect();
    }, []);

    return (
        <div
            ref={containerRef}
            className={`split-layout ${auxVisible ? 'aux-visible' : 'aux-hidden'}`}
            data-orientation={isWide ? 'vertical' : 'horizontal'}
        >
            <div ref={mainRef} className="split-panel main-panel">
                {mainPanel}
            </div>
            {auxVisible && (
                <div ref={auxRef} className="split-panel auxiliary-panel">
                    {auxiliaryPanel}
                </div>
            )}
        </div>
    );
}
