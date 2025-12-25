/**
 * Auxiliary Panel Context
 * 
 * State management for the multi-purpose auxiliary panel.
 * Both the agent (via MCP tool) and user (via tabs) can control the display.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import type { Task } from '../agent/TaskManager';

// ============ Types ============

export type AuxiliaryMode = 'tasks' | 'file' | 'artifact';

export interface FileContent {
    path: string;
    content: string;
    language?: string;
}

export interface ArtifactContent {
    title: string;
    content: string;
    type?: 'text' | 'json' | 'html' | 'markdown';
}

export interface AuxiliaryPanelState {
    mode: AuxiliaryMode;
    tasks: Task[];
    file: FileContent | null;
    artifact: ArtifactContent | null;
}

export interface AuxiliaryPanelContextValue extends AuxiliaryPanelState {
    setMode: (mode: AuxiliaryMode) => void;
    showFile: (path: string, content: string, language?: string) => void;
    showArtifact: (title: string, content: string, type?: ArtifactContent['type']) => void;
    showTasks: () => void;
    updateTasks: (tasks: Task[]) => void;
}

// ============ Context ============

const AuxiliaryPanelContext = createContext<AuxiliaryPanelContextValue | null>(null);

export function useAuxiliaryPanel(): AuxiliaryPanelContextValue {
    const ctx = useContext(AuxiliaryPanelContext);
    if (!ctx) {
        throw new Error('useAuxiliaryPanel must be used within AuxiliaryPanelProvider');
    }
    return ctx;
}

// Optional hook that doesn't throw
export function useAuxiliaryPanelOptional(): AuxiliaryPanelContextValue | null {
    return useContext(AuxiliaryPanelContext);
}

// ============ Provider ============

interface ProviderProps {
    children: ReactNode;
}

export function AuxiliaryPanelProvider({ children }: ProviderProps) {
    const [state, setState] = useState<AuxiliaryPanelState>({
        mode: 'tasks',
        tasks: [],
        file: null,
        artifact: null,
    });

    const setMode = useCallback((mode: AuxiliaryMode) => {
        setState(prev => ({ ...prev, mode }));
    }, []);

    const showFile = useCallback((path: string, content: string, language?: string) => {
        setState(prev => ({
            ...prev,
            mode: 'file',
            file: { path, content, language },
        }));
    }, []);

    const showArtifact = useCallback((title: string, content: string, type?: ArtifactContent['type']) => {
        setState(prev => ({
            ...prev,
            mode: 'artifact',
            artifact: { title, content, type: type ?? 'text' },
        }));
    }, []);

    const showTasks = useCallback(() => {
        setState(prev => ({ ...prev, mode: 'tasks' }));
    }, []);

    const updateTasks = useCallback((tasks: Task[]) => {
        setState(prev => ({ ...prev, tasks }));
    }, []);

    const value: AuxiliaryPanelContextValue = {
        ...state,
        setMode,
        showFile,
        showArtifact,
        showTasks,
        updateTasks,
    };

    return (
        <AuxiliaryPanelContext.Provider value={value}>
            {children}
        </AuxiliaryPanelContext.Provider>
    );
}

// ============ Singleton for MCP tool access ============

let globalPanelRef: AuxiliaryPanelContextValue | null = null;

export function setGlobalAuxiliaryPanel(panel: AuxiliaryPanelContextValue | null): void {
    globalPanelRef = panel;
}

export function getGlobalAuxiliaryPanel(): AuxiliaryPanelContextValue | null {
    return globalPanelRef;
}
