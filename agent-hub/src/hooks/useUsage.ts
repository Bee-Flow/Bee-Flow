/**
 * useUsage — ONE fetch of "who uses this thing", shared by the Used-by tab,
 * the editor and the delete confirmation (Bee Flow Builder redesign, Sep
 * 2026, Track 0.4). Generalises `Datatables/DatatableDetail.jsx`'s
 * `useUsage(tableId)` to every kind that answers `GET /api/<kind>/:id/usage`.
 *
 * ── ONE USAGE FETCH, NOT THREE ──────────────────────────────────────
 * The column designer, the Used-by tab and the delete confirmation all need
 * the same list, and each used to fetch it for itself — three requests on
 * every open, three chances for them to disagree about what depends on this
 * thing while somebody is deciding whether to break it. So the hook lives in
 * the DETAIL, once, and hands the list down. A panel never calls this itself.
 *
 * ── null IS NOT [] ──────────────────────────────────────────────────
 *   `usage === null`  → not loaded yet: the delete dialog must not treat this
 *                       as "nothing depends on it";
 *   `usage === []`    → loaded, and nothing uses it.
 * A failed read must not leave the list at null forever, because "still
 * loading" and "nothing depends on this" look identical from the delete
 * confirmation. On error the list becomes [] and `error` says why, so the
 * dialog can fall back to the server's own 409 guard (which it always keeps).
 *
 * The rows follow the usage contract that `shared/UsedByTab.jsx` renders.
 * A legacy endpoint (the datatables index still answers `{automationId,
 * automationTitle, automationOwner, stepId, mode, columns}`) is mapped at
 * the RENDER side via `UsedByTab`'s `adapt` prop, so this hook stays shape-
 * agnostic and the compatibility tests for datatables need no edit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/** One "this depends on you" row. A legacy endpoint answers a different
 *  shape, adapted at the render side, so nothing beyond the list is claimed. */
export type UsageRow = Record<string, unknown>;

export type UsageKind = 'kb' | 'agent' | 'skill' | 'datatable' | 'webpage' | 'meeting';

/**
 * The API path segment per kind. Only kinds with a usage endpoint appear
 * here; anything else needs an explicit `fetcher`, and the default fetcher
 * refuses rather than guessing a URL that would 404 into a silent [].
 *
 * Which of these the server ANSWERS today: only `datatables` (GET
 * /api/datatables/:id/usage). The other endpoints land with their tracks —
 * kb → K5, agents → A1, skills → S1, webpages → W5, transcriptions → M2 —
 * and until each one does, the hook resolves to the "could not load who
 * uses this" state for that kind (a 404 is an error, so `usage` becomes []
 * with `error` set, never a silent "nothing depends on it"). The map is
 * deliberately not shrunk to the one live kind: it is the contract the
 * tracks build against, and a consumer wired up now needs no client change
 * when its endpoint arrives.
 */
export const USAGE_KIND_PATH: Readonly<Record<string, string>> = Object.freeze({
    kb: 'kb',
    agent: 'agents',
    skill: 'skills',
    datatable: 'datatables',
    webpage: 'webpages',
    meeting: 'transcriptions',
});

/** `${API_BASE}/api/<kindPath>/<id>/usage`, or null for a kind without one. */
export function usageUrl(kind: string, id: string | number | null | undefined): string | null {
    const segment = USAGE_KIND_PATH[kind];
    if (!segment || id == null || id === '') return null;
    return `${API_BASE}/api/${segment}/${encodeURIComponent(String(id))}/usage`;
}

/**
 * The server answers `{ usage: [...] }` (datatables) — accept a bare array
 * too, so a future module that returns the list directly is not a client
 * change. Anything else is "loaded, empty".
 */
export function normaliseUsage(body: unknown): UsageRow[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object' && Array.isArray((body as { usage?: unknown }).usage)) {
        return (body as { usage: UsageRow[] }).usage;
    }
    return [];
}

/**
 * The kinds the server could NOT answer for — a consumer table that is not on
 * this install, or a scan that errored (`{ unchecked: ['app'] }`, K5).
 *
 * It is not decoration. "I could not check apps" and "no app uses this" are
 * different statements, and the delete confirmation reads the second one as
 * safe to press. Dropping this at the client boundary would put the server's
 * careful distinction back where it started, so it travels with the rows.
 */
export function normaliseUnchecked(body: unknown): string[] {
    if (body && typeof body === 'object' && Array.isArray((body as { unchecked?: unknown }).unchecked)) {
        return (body as { unchecked: unknown[] }).unchecked.filter((k): k is string => typeof k === 'string');
    }
    return [];
}

/** A failed read, carrying datatablesApi's fields so a caller can tell a 403
 *  from a 404 if it wants to. */
export interface UsageError extends Error {
    status?: number;
    code?: string | null;
    body?: unknown;
}

export type UsageFetcher = (kind: string, id: string | number | null | undefined) => Promise<unknown>;

/** Default transport: GET the usage endpoint through the app's authFetch. */
export async function defaultUsageFetcher(kind: string, id: string | number | null | undefined): Promise<unknown> {
    const url = usageUrl(kind, id);
    if (!url) throw new Error(`No usage endpoint for kind "${kind}"`);
    const res = await authFetch(url);
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
        const err: UsageError = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.body = body;
        throw err;
    }
    return body;
}

export interface UseUsageReturn {
    /** null until the first answer lands; [] means "loaded, nothing uses it". */
    usage: UsageRow[] | null;
    unchecked: string[];
    error: string | null;
    loading: boolean;
    refetch: () => void;
    /**
     * For one caller: the delete dialog, when the server's 409 `in_use`
     * payload is fresher than the list on screen. Replacing the shared list
     * there keeps the tab and the dialog telling the same story.
     */
    setUsage: (rows: UsageRow[], unchecked?: string[]) => void;
}

interface LoadedUsage {
    key: string | null;
    usage: UsageRow[] | null;
    unchecked: string[];
    error: string | null;
}

/**
 * `id` falsy = not saved yet, so nothing can use it → [].
 */
export default function useUsage(
    kind: string,
    id: string | number | null | undefined,
    { fetcher = defaultUsageFetcher }: { fetcher?: UsageFetcher } = {},
): UseUsageReturn {
    const [generation, setGeneration] = useState(0);
    const noId = id == null || id === '';
    // What is on screen is keyed by the request it answers, so "the id
    // changed" is a derivation during render (the key no longer matches →
    // null), not a setState inside the effect that would repaint twice.
    const key = noId ? null : `${kind}\u0000${id}\u0000${generation}`;
    const [loaded, setLoaded] = useState<LoadedUsage>({ key: null, usage: null, unchecked: [], error: null });
    // The fetcher is usually an inline arrow; keeping it in a ref means a new
    // identity per render does not refetch, and refetch() still sees the
    // latest one. Updated in an effect (declared first, so it runs before
    // the fetch effect of the same commit), never during render.
    const fetcherRef = useRef(fetcher);
    useEffect(() => { fetcherRef.current = fetcher; });

    useEffect(() => {
        // Not saved yet: nothing can reference it, and there is no URL to ask.
        if (key === null) return undefined;
        let alive = true;
        // Call synchronously so a caller can observe the request the moment
        // the id changes; a fetcher that throws instead of rejecting is
        // folded into the same failure path.
        let pending: Promise<unknown>;
        try {
            pending = Promise.resolve(fetcherRef.current(kind, id));
        } catch (e) {
            pending = Promise.reject(e);
        }
        pending
            .then((body) => { if (alive) setLoaded({ key, usage: normaliseUsage(body), unchecked: normaliseUnchecked(body), error: null }); })
            // A failed read is itself a "could not check": the caller must not
            // read the empty list as "nothing depends on this".
            .catch((e: unknown) => {
                if (alive) setLoaded({ key, usage: [], unchecked: [], error: (e instanceof Error && e.message) || 'usage' });
            });
        return () => { alive = false; };
    }, [kind, id, key]);

    const refetch = useCallback(() => setGeneration((n) => n + 1), []);

    const replace = useCallback((rows: UsageRow[], unchecked: string[] = []) => {
        setLoaded({ key, usage: Array.isArray(rows) ? rows : [], unchecked, error: null });
    }, [key]);

    const current = loaded.key === key;
    const usage = noId ? [] : (current ? loaded.usage : null);
    const unchecked = current ? loaded.unchecked : [];
    const error = current ? loaded.error : null;
    return { usage, unchecked, error, loading: usage === null, refetch, setUsage: replace };
}
