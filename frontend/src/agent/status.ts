/**
 * Status Display
 * 
 * Manages the status indicator in the UI.
 */

/**
 * Update the status display element.
 */
export function setStatus(status: string, color = '#3fb950'): void {
    const el = document.getElementById('status');
    if (el) {
        el.textContent = status;
        el.style.color = color;
    }
}
