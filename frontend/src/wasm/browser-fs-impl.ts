/**
 * Browser File System implementation for WASM component
 * 
 * Architecture:
 * - In-memory index tracks all files/directories (instant for list/grep)
 * - In-memory content cache for sync read access
 * - OPFS with SyncAccessHandle for persistence
 * - Sandbox starts empty, so no startup scan needed
 */

// ============================================================
// IN-MEMORY FILE SYSTEM STATE (synchronous access)
// ============================================================

/** Set of all file paths (e.g., "foo/bar.txt") */
const fileIndex = new Set<string>();

/** Set of all directory paths (e.g., "foo/bar/") */
const dirIndex = new Set<string>(['/']);

/** Map of file path -> content */
const fileContents = new Map<string, string>();

// ============================================================
// OPFS BACKGROUND PERSISTENCE
// ============================================================

let opfsRoot: FileSystemDirectoryHandle | null = null;

// Initialize OPFS in background
(async () => {
    try {
        opfsRoot = await navigator.storage.getDirectory();
        console.log('[browser-fs] OPFS root ready for persistence');
    } catch (e) {
        console.warn('[browser-fs] OPFS not available, running memory-only:', e);
    }
})();

/**
 * Persist file to OPFS in background (fire-and-forget)
 */
async function persistToOpfs(path: string, content: string): Promise<void> {
    if (!opfsRoot) return;

    try {
        const parts = path.split('/').filter(p => p && p !== '.');
        if (parts.length === 0) return;

        // Navigate/create directories
        let dir = opfsRoot;
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i], { create: true });
        }

        // Create/get file handle and write
        const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });

        // Try sync access handle (faster)
        try {
            const accessHandle = await fileHandle.createSyncAccessHandle();
            const encoder = new TextEncoder();
            const data = encoder.encode(content);
            accessHandle.truncate(0);
            accessHandle.write(data, { at: 0 });
            accessHandle.flush();
            accessHandle.close();
        } catch {
            // Fall back to writable stream
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
        }
    } catch (e) {
        console.error('[browser-fs] OPFS persist failed:', e);
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Normalize path - remove leading/trailing slashes, handle "."
 */
function normalizePath(path: string): string {
    if (!path || path === '/' || path === '.') return '';
    return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/**
 * Get parent directory of a path
 */
function getParentDir(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? '' : normalized.substring(0, lastSlash);
}

/**
 * Ensure parent directories exist in index
 */
function ensureParentDirs(path: string): void {
    const parts = normalizePath(path).split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        dirIndex.add(current);
    }
}

// ============================================================
// SYNCHRONOUS FILE SYSTEM OPERATIONS
// ============================================================

/**
 * Read file content
 */
function readFile(path: string): string {
    console.log('[browser-fs] readFile:', path);

    const normalized = normalizePath(path);

    if (!fileIndex.has(normalized)) {
        return JSON.stringify({ ok: false, error: `File not found: ${path}` });
    }

    const content = fileContents.get(normalized) ?? '';
    return JSON.stringify({ ok: true, content });
}

/**
 * Write file content
 */
function writeFile(path: string, content: string): string {
    console.log('[browser-fs] writeFile:', path, 'length:', content.length);

    const normalized = normalizePath(path);
    if (!normalized) {
        return JSON.stringify({ ok: false, error: 'Invalid path' });
    }

    // Update in-memory state (synchronous)
    ensureParentDirs(normalized);
    fileIndex.add(normalized);
    fileContents.set(normalized, content);

    // Persist to OPFS in background (async, fire-and-forget)
    persistToOpfs(normalized, content).catch(() => { });

    return JSON.stringify({ ok: true });
}

/**
 * List directory contents
 */
function listDir(path: string): string {
    console.log('[browser-fs] listDir:', path);

    const normalized = normalizePath(path);
    const prefix = normalized ? `${normalized}/` : '';
    const entries: string[] = [];
    const seen = new Set<string>();

    // Find all files in this directory
    for (const filePath of fileIndex) {
        if (filePath.startsWith(prefix)) {
            const rest = filePath.slice(prefix.length);
            const firstPart = rest.split('/')[0];
            if (firstPart && !seen.has(firstPart)) {
                seen.add(firstPart);
                // Check if it's a directory (has children)
                const isDir = rest.includes('/');
                entries.push(isDir ? `${firstPart}/` : firstPart);
            }
        }
    }

    // Also add empty directories
    for (const dirPath of dirIndex) {
        if (dirPath.startsWith(prefix) && dirPath !== prefix.slice(0, -1)) {
            const rest = dirPath.slice(prefix.length);
            const firstPart = rest.split('/')[0];
            if (firstPart && !seen.has(firstPart)) {
                seen.add(firstPart);
                entries.push(`${firstPart}/`);
            }
        }
    }

    return JSON.stringify({ ok: true, entries: entries.sort() });
}

/**
 * Search for pattern in files
 */
function grep(pattern: string, path: string): string {
    console.log('[browser-fs] grep:', pattern, 'in', path);

    try {
        const normalized = normalizePath(path);
        const prefix = normalized ? `${normalized}/` : '';
        const regex = new RegExp(pattern, 'gi');
        const matches: Array<{ file: string; line: number; text: string }> = [];

        for (const [filePath, content] of fileContents) {
            if (filePath.startsWith(prefix) || !normalized) {
                const lines = content.split('\n');
                lines.forEach((lineText, idx) => {
                    if (regex.test(lineText)) {
                        matches.push({
                            file: filePath,
                            line: idx + 1,
                            text: lineText.trim().substring(0, 100)
                        });
                    }
                    regex.lastIndex = 0; // Reset for global regex
                });
            }
        }

        return JSON.stringify({ ok: true, matches });
    } catch (e) {
        return JSON.stringify({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            matches: []
        });
    }
}

// ============================================================
// EXPORTS
// ============================================================

export const browserFs = { readFile, writeFile, listDir, grep };
export { readFile, writeFile, listDir, grep };
