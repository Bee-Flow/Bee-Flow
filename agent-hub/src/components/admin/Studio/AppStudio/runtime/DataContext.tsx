import React, { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * App Studio runtime — the data-source state provider.
 *
 * Holds `dataState`, a map keyed by a binding's stable cache-key (see
 * dataCacheKey in resolveBinding.js) of `{ status, result, error, tableId?,
 * datasetId? }` entries — mirroring actionState's status vocabulary so
 * resolveBinding treats action- and data-bindings identically.
 *
 * The provider only STORES entries; the actual fetching is done by
 * useAppDataSource (built on react-query), which writes results back here via
 * setEntry. Keeping the store separate from the fetch keeps the renderer
 * synchronous and lets many components share one query per cache-key.
 *
 * Reading is via useDataState(); resolveBinding is given this map in its bag.
 */

/** One binding's data entry, as the fetchers write it. */
export interface DataEntry {
    status?: string;
    result?: unknown;
    error?: unknown;
    errorCode?: unknown;
    errorProvider?: unknown;
    tableId?: string | null;
    datasetId?: string | null;
    connectorId?: string | number | null;
}

/** Every binding's entry, by cache key (each value is a DataEntry; see dataEntryOf). */
export type DataState = Record<string, unknown>;

export interface DataContextValue {
    dataState: DataState;
    appId: string | null;
    draft: boolean;
    setEntry: (key: string, entry: DataEntry) => void;
    removeEntry: (key: string) => void;
    retainEntry: (key: string) => void;
    releaseEntry: (key: string) => void;
}

const EMPTY: DataState = Object.freeze({});

// Safety net only: entries are evicted when their fetcher unmounts
// (useAppDataSource), so a live screen holds one entry per binding and never
// reaches this. Far above any real screen's binding count, so the oldest-first
// drop below can't evict an entry something on screen is still reading.
const MAX_DATA_ENTRIES = 200;

const DataContext = createContext<DataContextValue>({
    dataState: EMPTY,
    appId: null,
    draft: false,
    setEntry: () => {},
    removeEntry: () => {},
    retainEntry: () => {},
    releaseEntry: () => {},
});

/**
 * `draft` tells components whose server calls resolve against the app
 * DEFINITION (today: ai_chat) which one to ask for — the editor preview runs
 * the unsaved draft, a published run page the frozen published definition. It
 * mirrors the `draft` option Canvas already passes to useActionRunner.
 */
export function DataProvider({ appId = null, draft = false, initialState = null, children }: {
    appId?: string | null;
    draft?: boolean;
    initialState?: DataState | null;
    children?: ReactNode;
}) {
    const [dataState, setDataState] = useState<DataState>(initialState || EMPTY);

    const setEntry = useCallback((key: string, entry: DataEntry) => {
        if (!key) return;
        setDataState((prev) => {
            const cur = prev[key] as DataEntry | undefined;
            // Content bail: writers rebuild the entry object every effect run;
            // an identity check alone would churn state (and can loop effects).
            if (cur === entry) return prev;
            if (cur && entry
                && cur.status === entry.status && cur.result === entry.result
                && cur.error === entry.error && cur.errorCode === entry.errorCode
                && cur.errorProvider === entry.errorProvider
                && cur.tableId === entry.tableId
                && cur.datasetId === entry.datasetId) return prev;
            const next: DataState = { ...prev, [key]: entry };
            const keys = Object.keys(next);
            const excess = keys.length - MAX_DATA_ENTRIES;
            // Insertion-ordered: rewriting an existing key keeps its position,
            // so the head of the list is the oldest entry.
            for (let i = 0; i < excess; i++) {
                if (keys[i] !== key) delete next[keys[i]];
            }
            return next;
        });
    }, []);

    /**
     * How many live fetchers are holding each cache key.
     *
     * Eviction used to be unconditional: one fetcher unmounting deleted the
     * entry every other consumer of that key was reading. That is reachable
     * without doing anything unusual — AppInputRelation mounts its own loader
     * outside AppDataScope's deduped scan, so two relation pickers over the
     * same table build byte-identical bindings and therefore the same key.
     * Hide one behind a visibleWhen and the other showed "Loading…" for the
     * rest of the screen's life: its mirror effect does not re-run (its deps
     * are unchanged and react-query answers from cache), so nothing ever wrote
     * the entry back.
     *
     * A ref rather than state — a holder count is bookkeeping, and rendering on
     * every mount/unmount of a fetcher would be pure churn.
     */
    const holdersRef = useRef(new Map<string, number>());

    const retainEntry = useCallback((key: string) => {
        if (!key) return;
        holdersRef.current.set(key, (holdersRef.current.get(key) || 0) + 1);
    }, []);

    const dropEntry = useCallback((key: string) => {
        setDataState((prev) => {
            if (!key || !Object.prototype.hasOwnProperty.call(prev, key)) return prev;
            const next: DataState = { ...prev };
            delete next[key];
            return next;
        });
    }, []);

    /** Release one hold; the entry goes only when the last holder does. */
    const releaseEntry = useCallback((key: string) => {
        if (!key) return;
        const left = (holdersRef.current.get(key) || 0) - 1;
        if (left > 0) { holdersRef.current.set(key, left); return; }
        holdersRef.current.delete(key);
        dropEntry(key);
    }, [dropEntry]);

    // Kept for callers that own a key outright. The fetchers use retain/release.
    const removeEntry = useCallback((key: string) => {
        holdersRef.current.delete(key);
        dropEntry(key);
    }, [dropEntry]);

    const value = useMemo(
        () => ({ dataState, appId, draft, setEntry, removeEntry, retainEntry, releaseEntry }),
        [dataState, appId, draft, setEntry, removeEntry, retainEntry, releaseEntry],
    );

    return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useDataContext(): DataContextValue {
    return useContext(DataContext);
}

export function useDataState(): DataState {
    return useContext(DataContext).dataState;
}

export default DataContext;
