/**
 * Tests for Task Manager
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTaskManager, resetTaskManager } from './TaskManager';

describe('TaskManager', () => {
    beforeEach(() => {
        resetTaskManager();
    });

    describe('setTasks', () => {
        it('sets tasks and assigns IDs if missing', () => {
            const manager = getTaskManager();
            manager.setTasks([
                { id: '', content: 'Task 1', status: 'pending' },
                { id: 'abc', content: 'Task 2', status: 'in_progress' },
            ]);
            const tasks = manager.getTasks();
            expect(tasks).toHaveLength(2);
            expect(tasks[0].content).toBe('Task 1');
            expect(tasks[0].id).toBeTruthy(); // Generated ID
            expect(tasks[1].id).toBe('abc');
        });

        it('defaults status to pending', () => {
            const manager = getTaskManager();
            manager.setTasks([
                { id: '1', content: 'Test', status: undefined as unknown as 'pending' },
            ]);
            expect(manager.getTasks()[0].status).toBe('pending');
        });
    });

    describe('markInProgress', () => {
        it('marks task as in_progress', () => {
            const manager = getTaskManager();
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            manager.markInProgress('1');
            expect(manager.getTasks()[0].status).toBe('in_progress');
        });

        it('does nothing for unknown ID', () => {
            const manager = getTaskManager();
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            manager.markInProgress('unknown');
            expect(manager.getTasks()[0].status).toBe('pending');
        });
    });

    describe('markCompleted', () => {
        it('marks task as completed', () => {
            const manager = getTaskManager();
            manager.setTasks([{ id: '1', content: 'Test', status: 'in_progress' }]);
            manager.markCompleted('1');
            expect(manager.getTasks()[0].status).toBe('completed');
        });
    });

    describe('clear', () => {
        it('removes all tasks', () => {
            const manager = getTaskManager();
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            manager.clear();
            expect(manager.getTasks()).toHaveLength(0);
        });
    });

    describe('subscribe', () => {
        it('notifies listeners on setTasks', () => {
            const manager = getTaskManager();
            const listener = vi.fn();
            manager.subscribe(listener);
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            expect(listener).toHaveBeenCalledWith([
                { id: '1', content: 'Test', status: 'pending' }
            ]);
        });

        it('notifies listeners on status changes', () => {
            const manager = getTaskManager();
            const listener = vi.fn();
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            manager.subscribe(listener);
            manager.markInProgress('1');
            expect(listener).toHaveBeenCalled();
            expect(listener.mock.calls[0][0][0].status).toBe('in_progress');
        });

        it('returns unsubscribe function', () => {
            const manager = getTaskManager();
            const listener = vi.fn();
            const unsubscribe = manager.subscribe(listener);
            unsubscribe();
            manager.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('singleton', () => {
        it('returns same instance', () => {
            const a = getTaskManager();
            const b = getTaskManager();
            expect(a).toBe(b);
        });

        it('resetTaskManager creates new instance', () => {
            const a = getTaskManager();
            a.setTasks([{ id: '1', content: 'Test', status: 'pending' }]);
            resetTaskManager();
            const b = getTaskManager();
            expect(b.getTasks()).toHaveLength(0);
        });
    });
});
