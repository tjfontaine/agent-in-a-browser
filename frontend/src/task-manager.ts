/**
 * Task Manager
 * 
 * Manages task state for the AI agent's task tracking feature.
 * Tasks are displayed in the TUI to show progress on multi-step work.
 */

// ============ Types ============

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
    id: string;
    content: string;
    status: TaskStatus;
}

// ============ Task Manager ============

type TaskListener = (tasks: Task[]) => void;

class TaskManager {
    private tasks: Task[] = [];
    private listeners: Set<TaskListener> = new Set();

    /**
     * Set the entire task list (replaces existing tasks).
     */
    setTasks(tasks: Task[]): void {
        this.tasks = tasks.map(t => ({
            id: t.id || crypto.randomUUID(),
            content: t.content,
            status: t.status || 'pending',
        }));
        this.emit();
        // Auto-show aux panel when tasks are added
        if (tasks.length > 0) {
            import('./components/SplitLayout').then(({ setAuxPanelVisible }) => {
                setAuxPanelVisible(true);
            });
        }
    }

    /**
     * Mark a task as in_progress by ID.
     */
    markInProgress(id: string): void {
        const task = this.tasks.find(t => t.id === id);
        if (task) {
            task.status = 'in_progress';
            this.emit();
        }
    }

    /**
     * Mark a task as completed by ID.
     */
    markCompleted(id: string): void {
        const task = this.tasks.find(t => t.id === id);
        if (task) {
            task.status = 'completed';
            this.emit();
        }
    }

    /**
     * Get all tasks.
     */
    getTasks(): Task[] {
        return [...this.tasks];
    }

    /**
     * Clear all tasks.
     */
    clear(): void {
        this.tasks = [];
        this.emit();
    }

    /**
     * Subscribe to task updates.
     */
    subscribe(callback: TaskListener): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener(this.tasks);
        }
    }
}

// ============ Singleton Export ============

let instance: TaskManager | null = null;

export function getTaskManager(): TaskManager {
    if (!instance) {
        instance = new TaskManager();
    }
    return instance;
}

// For testing - allows resetting singleton
export function resetTaskManager(): void {
    instance = null;
}
