/**
 * TaskPanel Component
 * 
 * Displays the agent's task list in the TUI.
 * Subscribes to TaskManager for real-time updates.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink-web';
import { getTaskManager, Task } from '../task-manager';

const colors = {
    cyan: '#39c5cf',
    green: '#3fb950',
    yellow: '#d29922',
    dim: '#8b949e',
    magenta: '#bc8cff',
};

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

export function TaskPanel() {
    const [tasks, setTasks] = useState<Task[]>([]);

    useEffect(() => {
        const manager = getTaskManager();
        // Get initial tasks
        setTasks(manager.getTasks());
        // Subscribe to updates
        return manager.subscribe(setTasks);
    }, []);

    if (tasks.length === 0) {
        return null; // Don't render if no tasks
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={colors.cyan}
            paddingX={1}
            marginBottom={1}
        >
            <Text bold color={colors.cyan}>📋 Tasks</Text>
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
