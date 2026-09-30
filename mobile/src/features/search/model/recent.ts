/**
 * Recent searches, persisted on the device.
 *
 * The web client keeps the same list in localStorage under
 * `beeflow.search.recent` (agent-hub SearchOverlay). This is the phone's own
 * copy, under a namespaced key, and it deliberately never leaves the device:
 * search terms are some of the most revealing text a person types, and this is
 * a privacy product. There is no server endpoint for them and there should not
 * be one.
 *
 * Reads and writes are best-effort. AsyncStorage failing is not a reason to
 * fail a search — the list just comes back empty.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'beeflow.search.recent.v1';
const MAX_RECENT = 8;

export async function loadRecentSearches(): Promise<string[]> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, MAX_RECENT);
    } catch {
        return [];
    }
}

/**
 * Move `term` to the front, de-duplicated case-insensitively so "Invoice" does
 * not sit next to "invoice". Returns the new list so the caller can render it
 * without a second read.
 */
export async function pushRecentSearch(term: string): Promise<string[]> {
    const trimmed = term.trim();
    if (!trimmed) return loadRecentSearches();
    const existing = await loadRecentSearches();
    const lower = trimmed.toLowerCase();
    const next = [trimmed, ...existing.filter((t) => t.toLowerCase() !== lower)].slice(0, MAX_RECENT);
    try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* the list is a convenience; losing it is not worth surfacing */
    }
    return next;
}

export async function removeRecentSearch(term: string): Promise<string[]> {
    const lower = term.trim().toLowerCase();
    const next = (await loadRecentSearches()).filter((t) => t.toLowerCase() !== lower);
    try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* ignore */
    }
    return next;
}

export async function clearRecentSearches(): Promise<void> {
    try {
        await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
        /* ignore */
    }
}
