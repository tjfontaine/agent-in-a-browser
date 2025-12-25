/**
 * AuxiliaryPanel Component
 * 
 * Multi-purpose panel rendered in its own InkXterm terminal.
 * Displays: Tasks | File contents | Artifacts
 * 
 * User can switch with tabs, agent can switch programmatically.
 * 
 * NOTE: InkXterm creates a separate React root, so we can't use React context
 * inside the Ink components. Instead, we use direct state management via
 * the TaskManager and global panel singleton.
 */

import { useEffect, useState } from 'react';
import { InkXterm, Box, Text, useInput } from 'ink-web';
import { setGlobalAuxiliaryPanel, AuxiliaryMode, FileContent, ArtifactContent, AuxiliaryPanelContextValue } from './AuxiliaryPanelContext';
import { focusMainPanel } from './SplitLayout';
import { getTaskManager, Task } from '../agent/TaskManager';
import 'ink-web/css';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    dim: '#8b949e',
    magenta: '#bc8cff',
    white: '#e6edf3',
};

// ============ Inner Components (rendered inside InkXterm) ============

interface PanelState {
    mode: AuxiliaryMode;
    tasks: Task[];
    file: FileContent | null;
    artifact: ArtifactContent | null;
}

// Tab bar for mode switching with flash animation
function TabBar({ mode, setMode }: { mode: AuxiliaryMode; setMode: (m: AuxiliaryMode) => void }) {
    const [flash, setFlash] = useState<AuxiliaryMode | null>(null);

    const tabs: Array<{ key: AuxiliaryMode; label: string; shortcut: string }> = [
        { key: 'tasks', label: '📋 Tasks', shortcut: '1' },
        { key: 'file', label: '📄 File', shortcut: '2' },
        { key: 'artifact', label: '✨ Output', shortcut: '3' },
    ];

    // Handle tab switch with flash effect
    const handleSwitch = (newMode: AuxiliaryMode) => {
        if (newMode !== mode) {
            setFlash(newMode);
            setMode(newMode);
            // Clear flash after brief delay (timed for visual effect)
            setTimeout(() => setFlash(null), 150);
        }
    };

    // Keyboard shortcuts for switching tabs + Ctrl+\ to switch back to main
    useInput((input) => {
        if (input === '1') handleSwitch('tasks');
        else if (input === '2') handleSwitch('file');
        else if (input === '3') handleSwitch('artifact');
        // Ctrl+\ sends ASCII 28 - switch back to main panel
        else if (input === '\x1c') {
            focusMainPanel();
        }
    });

    // Get tab colors - flash briefly on switch
    const getTabColor = (tab: typeof tabs[0]) => {
        const isActive = mode === tab.key;
        const isFlashing = flash === tab.key;

        if (isFlashing) {
            return { color: '#000', bg: colors.yellow }; // Flash yellow
        }
        if (isActive) {
            return { color: '#000', bg: colors.cyan };
        }
        return { color: colors.dim, bg: undefined };
    };

    return (
        <Box flexDirection="row" gap={2} marginBottom={1}>
            {tabs.map(tab => {
                const style = getTabColor(tab);
                return (
                    <Text
                        key={tab.key}
                        color={style.color}
                        backgroundColor={style.bg}
                        bold={mode === tab.key}
                    >
                        {` ${tab.shortcut} ${tab.label} `}
                    </Text>
                );
            })}
        </Box>
    );
}

// Tasks view
function TasksView({ tasks }: { tasks: Task[] }) {
    if (tasks.length === 0) {
        return <Text color={colors.dim}>No active tasks</Text>;
    }

    return (
        <Box flexDirection="column">
            {tasks.map(task => (
                <Box key={task.id} gap={1}>
                    <TaskIcon status={task.status} />
                    <Text
                        color={task.status === 'completed' ? colors.dim : undefined}
                        strikethrough={task.status === 'completed'}
                    >
                        {task.content}
                    </Text>
                </Box>
            ))}
        </Box>
    );
}

function TaskIcon({ status }: { status: Task['status'] }) {
    switch (status) {
        case 'pending':
            return <Text color={colors.dim}>○</Text>;
        case 'in_progress':
            return <Text color={colors.yellow}>●</Text>;
        case 'completed':
            return <Text color={colors.green}>✓</Text>;
    }
}

// File view
function FileView({ file }: { file: FileContent | null }) {
    if (!file) {
        return <Text color={colors.dim}>No file loaded. Use /view command or agent action.</Text>;
    }

    return (
        <Box flexDirection="column">
            <Text color={colors.cyan} bold>{file.path}</Text>
            <Box marginTop={1}>
                <Text>{file.content}</Text>
            </Box>
        </Box>
    );
}

// Artifact view
function ArtifactView({ artifact }: { artifact: ArtifactContent | null }) {
    if (!artifact) {
        return <Text color={colors.dim}>No artifact to display.</Text>;
    }

    return (
        <Box flexDirection="column">
            <Text color={colors.magenta} bold>✨ {artifact.title}</Text>
            <Box marginTop={1}>
                <Text>{artifact.content}</Text>
            </Box>
        </Box>
    );
}

// Content switcher
function PanelContent({ state }: { state: PanelState }) {
    switch (state.mode) {
        case 'tasks':
            return <TasksView tasks={state.tasks} />;
        case 'file':
            return <FileView file={state.file} />;
        case 'artifact':
            return <ArtifactView artifact={state.artifact} />;
    }
}

// Inner content rendered inside InkXterm
// Uses useState for local state since we can't use React context
function AuxiliaryPanelContent() {
    const [state, setState] = useState<PanelState>({
        mode: 'tasks',
        tasks: [],
        file: null,
        artifact: null,
    });

    const setMode = (mode: AuxiliaryMode) => {
        setState(prev => ({ ...prev, mode }));
    };

    // Register for global access (so agent/MCP can control the panel)
    useEffect(() => {
        const panelApi: AuxiliaryPanelContextValue = {
            ...state,
            setMode,
            showFile: (path: string, content: string, language?: string) => {
                setState(prev => ({ ...prev, mode: 'file', file: { path, content, language } }));
            },
            showArtifact: (title: string, content: string, type?: ArtifactContent['type']) => {
                setState(prev => ({ ...prev, mode: 'artifact', artifact: { title, content, type: type ?? 'text' } }));
            },
            showTasks: () => {
                setState(prev => ({ ...prev, mode: 'tasks' }));
            },
            updateTasks: (tasks: Task[]) => {
                setState(prev => ({ ...prev, tasks }));
            },
        };
        setGlobalAuxiliaryPanel(panelApi);
        return () => setGlobalAuxiliaryPanel(null);
    }, [state]);

    // Subscribe to TaskManager updates
    useEffect(() => {
        const manager = getTaskManager();
        // Get initial tasks
        setState(prev => ({ ...prev, tasks: manager.getTasks() }));
        // Subscribe to updates
        const unsubscribe = manager.subscribe((tasks) => {
            setState(prev => ({ ...prev, tasks }));
        });
        return unsubscribe;
    }, []);

    return (
        <Box flexDirection="column" paddingX={1} flexGrow={1}>
            <TabBar mode={state.mode} setMode={setMode} />
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
                <PanelContent state={state} />
            </Box>
        </Box>
    );
}

// ============ Main Export ============

export function AuxiliaryPanel() {
    return (
        <InkXterm focus={false}>
            <AuxiliaryPanelContent />
        </InkXterm>
    );
}
