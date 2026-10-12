/**
 * One draft store per open automation, handed out by key.
 *
 * The build screen, the step editor pushed over it and the settings screen
 * all ask for the same key and get the same store. Each screen RETAINS it
 * while mounted; when the last one lets go, the store is flushed and kept for
 * a grace period — long enough for a `router.replace` (the new-automation screen
 * handing over to the build screen) to pick it up again, history and all —
 * and then flushed once more and disposed, unless it is still unsaved: then
 * it stays, so nothing typed is thrown away while the app is open.
 *
 * A new automation has no id yet: its screen takes a one-off key, and when the
 * row is created the store is ALSO registered under the new id (`alias`), so
 * a screen opened for that id finds the store that created it.
 */

import type { DraftStore } from './types';

export const RELEASE_GRACE_MS = 10_000;
/** The longest wait between two more attempts to save a closed automation's unsaved edits. */
export const KEEP_TRYING_MAX_MS = 5 * 60_000;

interface Entry {
    store: DraftStore;
    keys: Set<string>;
    refs: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
let newKeys = 0;

/** A key for an automation that does not exist yet; unique per screen. */
export function newDraftKey(): string {
    newKeys += 1;
    return `new:${newKeys}`;
}

export function peekDraftStore(key: string): DraftStore | undefined {
    return entries.get(key)?.store;
}

/** How many open screens hold the store under `key`. */
export function draftHolders(key: string): number {
    return entries.get(key)?.refs ?? 0;
}

/** The store under `key`, created by `create` when there is none. Does not retain it. */
export function draftStoreFor(key: string, create: () => DraftStore): DraftStore {
    const existing = entries.get(key);
    if (existing) return existing.store;
    const entry: Entry = { store: create(), keys: new Set([key]), refs: 0, timer: null };
    entries.set(key, entry);
    return entry.store;
}

/** Also find the store under `key` under `alias` (a new automation's id, once it has one). */
export function aliasDraftStore(key: string, alias: string): void {
    const entry = entries.get(key);
    if (!entry || entries.get(alias) === entry) return;
    entry.keys.add(alias);
    entries.set(alias, entry);
}

export function retainDraftStore(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.refs += 1;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
}

function dispose(entry: Entry): void {
    for (const key of entry.keys) if (entries.get(key) === entry) entries.delete(key);
    entry.store.getState().dispose();
}

/**
 * After the grace period: flush once more, and dispose only a store the server
 * holds. One still unsaved (offline, a server that fails) is KEPT, found again
 * by the next screen that opens the automation, and flushed again later, backing
 * off up to KEEP_TRYING_MAX_MS; one the server refused waits for that screen.
 */
function settleLater(entry: Entry, delayMs: number): void {
    entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.refs > 0) return;
        void entry.store
            .getState()
            .flush()
            .finally(() => {
                if (entry.refs > 0) return;
                const s = entry.store.getState();
                if (!s.dirty) dispose(entry);
                else if (s.saveError?.kind !== 'permanent') settleLater(entry, Math.min(delayMs * 2, KEEP_TRYING_MAX_MS));
            });
    }, delayMs);
}

/** A screen let go. The last one out flushes, and the store goes after the grace period once it is saved. */
export function releaseDraftStore(key: string, graceMs = RELEASE_GRACE_MS): void {
    const entry = entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    void entry.store.getState().flush();
    settleLater(entry, graceMs);
}

/**
 * Make sure the server holds what is on screen for this automation, before
 * something reads the STORED definition (a test run, activation, a restore,
 * an AI turn). True when there is nothing unsaved — including when no editor
 * is open for it at all.
 */
export async function flushDraft(key: string): Promise<boolean> {
    const store = peekDraftStore(key);
    return store ? store.getState().flush() : true;
}

/** Tests only: forget every store. */
export function resetDraftRegistry(): void {
    for (const entry of new Set(entries.values())) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.store.getState().dispose();
    }
    entries.clear();
    newKeys = 0;
}
