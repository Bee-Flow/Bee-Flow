/**
 * User-scoped localStorage wrapper.
 *
 * All keys are namespaced by the current user id as `beeflow:${userId}:${key}`.
 * This prevents data leaks across accounts on shared browsers — switching
 * users drops the old user's favourites, last-used agent, etc.
 *
 * How to use:
 *
 *   1. At app boot, call `setCurrentUser(userId)` after resolving whoami.
 *   2. On logout, call `setCurrentUser(null)` + optionally `clearUser(previousId)`.
 *   3. Anywhere you would have written `localStorage.setItem('lastUsedAgentId', x)`,
 *      write `scopedStorage.setItem('lastUsedAgentId', x)` instead.
 *
 * Migration strategy: pre-scoping bare keys are moved into the scoped slot by
 * the ONE-TIME per-user pass in utils/storageMigrations.js, which reads AND
 * deletes the bare key. There is no lazy per-read migration anymore — the old
 * one copied a bare value into whichever account read it first and left the
 * original behind, so a second account on a shared browser could claim it too.
 *
 * Device-level keys (theme, locale) stay on raw localStorage — they're not
 * user-specific and should survive account switches.
 */

const PREFIX = 'beeflow';

let currentUserId: string | null = null;

/** The raw localStorage key for a user-scoped entry — shared with the
 *  migration pass so the format can't drift. */
export function scopedKey(userId: string, key: string): string {
    return `${PREFIX}:${userId}:${key}`;
}

/**
 * Register the active user. Passing null/undefined clears the active user —
 * subsequent reads return null until a new user is registered.
 */
export function setCurrentUser(userId: string | null | undefined): void {
    currentUserId = userId || null;
}

export function getCurrentUser(): string | null {
    return currentUserId;
}

/**
 * Read a user-scoped key. Returns null when no user is active or the key
 * doesn't exist. Bare (unscoped) keys are ignored here — the one-time pass
 * in storageMigrations.js has already moved the known ones over.
 */
export function getItem(key: string): string | null {
    if (!currentUserId) return null;
    try {
        return localStorage.getItem(scopedKey(currentUserId, key));
    } catch {
        return null;
    }
}

export function setItem(key: string, value: string): void {
    if (!currentUserId) return;
    try { localStorage.setItem(scopedKey(currentUserId, key), value); } catch { /* ignore quota */ }
}

export function removeItem(key: string): void {
    if (!currentUserId) return;
    try { localStorage.removeItem(scopedKey(currentUserId, key)); } catch { /* ignore */ }
}

/**
 * JSON helpers so call sites don't repeat try/catch. `fallback` is returned
 * when the stored value is missing or not valid JSON.
 */
export function getJSON<T = unknown>(key: string, fallback: T | null = null): T | null {
    const raw = getItem(key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function setJSON(key: string, value: unknown): void {
    try { setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/**
 * Remove ALL scoped keys for the given user. Call on logout.
 * Intentionally leaves device-level keys alone.
 */
export function clearUser(userId: string | null | undefined): void {
    if (!userId) return;
    try {
        const prefix = `${PREFIX}:${userId}:`;
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) toRemove.push(k);
        }
        for (const k of toRemove) localStorage.removeItem(k);
    } catch { /* ignore */ }
}

export default {
    setCurrentUser,
    getCurrentUser,
    getItem,
    setItem,
    removeItem,
    getJSON,
    setJSON,
    clearUser,
};
