/**
 * Task Panel
 * 
 * Manages the persistent task panel UI in the sidebar.
 * Subscribes to TaskManager and updates DOM when tasks change.
 */

import { getTaskManager, type Task } from './task-manager';

// ============ DOM Elements ============

let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

// ============ Icons ============

const ICONS = {
    pending: '○',
    in_progress: '⠋',
    completed: '✓',
};

// ============ Initialization ============

/**
 * Initialize the task panel and subscribe to TaskManager updates.
 */
export function initializeTaskPanel(): void {
    panelEl = document.getElementById('task-panel');
    listEl = document.getElementById('task-list');
    countEl = document.getElementById('task-count');
    emptyEl = document.getElementById('task-empty');

    if (!panelEl || !listEl) {
        console.warn('[TaskPanel] Panel elements not found');
        return;
    }

    // Subscribe to task changes
    getTaskManager().subscribe(renderTasks);

    // Initial render
    renderTasks(getTaskManager().getTasks());
}

// ============ Rendering ============

/**
 * Render the task list to the DOM.
 */
function renderTasks(tasks: Task[]): void {
    if (!panelEl || !listEl || !countEl) return;

    // Show/hide panel based on whether there are tasks
    if (tasks.length === 0) {
        panelEl.classList.add('hidden');
        return;
    }

    panelEl.classList.remove('hidden');

    // Update count
    const completedCount = tasks.filter(t => t.status === 'completed').length;
    countEl.textContent = `${completedCount}/${tasks.length} done`;

    // Clear existing items (keep empty element hidden)
    const existingItems = listEl.querySelectorAll('.task-item');
    existingItems.forEach(el => el.remove());

    // Hide empty message
    if (emptyEl) {
        emptyEl.style.display = 'none';
    }

    // Render each task
    for (const task of tasks) {
        const itemEl = document.createElement('div');
        itemEl.className = `task-item ${task.status}`;
        itemEl.innerHTML = `
            <span class="icon">${ICONS[task.status]}</span>
            <span class="content">${escapeHtml(task.content)}</span>
        `;
        listEl.appendChild(itemEl);
    }
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============ Manual Control ============

/**
 * Show the task panel.
 */
export function showTaskPanel(): void {
    panelEl?.classList.remove('hidden');
}

/**
 * Hide the task panel.
 */
export function hideTaskPanel(): void {
    panelEl?.classList.add('hidden');
}

/**
 * Clear all tasks and hide the panel.
 */
export function clearTaskPanel(): void {
    getTaskManager().clear();
}
