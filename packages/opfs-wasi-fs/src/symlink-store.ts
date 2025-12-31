/**
 * Symlink Store
 * 
 * IndexedDB-backed storage for symlink metadata.
 * Symlinks are stored as { path: string, target: string } records.
 */

const DB_NAME = 'web-agent-fs';
const DB_VERSION = 1;
const STORE_NAME = 'symlinks';

let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open or create the IndexedDB database
 */
function openDb(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'path' });
            }
        };

        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onerror = () => {
            console.error('[symlink-store] Failed to open IndexedDB:', request.error);
            reject(request.error);
        };
    });

    return dbPromise;
}

/**
 * Save a symlink to IndexedDB
 */
export async function saveSymlink(path: string, target: string): Promise<void> {
    const database = await openDb();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ path, target });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Delete a symlink from IndexedDB
 */
export async function deleteSymlink(path: string): Promise<void> {
    const database = await openDb();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(path);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Delete all symlinks under a path prefix (for directory removal)
 */
export async function deleteSymlinksUnderPath(pathPrefix: string): Promise<void> {
    const database = await openDb();
    const prefix = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';

    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();
        const toDelete: string[] = [];

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const record = cursor.value as { path: string; target: string };
                if (record.path.startsWith(prefix) || record.path === pathPrefix) {
                    toDelete.push(record.path);
                }
                cursor.continue();
            } else {
                // Cursor exhausted, delete collected paths
                for (const p of toDelete) {
                    store.delete(p);
                }
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Load all symlinks from IndexedDB
 * @returns Map of path -> target
 */
export async function loadAllSymlinks(): Promise<Map<string, string>> {
    const database = await openDb();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            const map = new Map<string, string>();
            for (const item of request.result) {
                map.set(item.path, item.target);
            }
            resolve(map);
        };

        request.onerror = () => reject(request.error);
    });
}
