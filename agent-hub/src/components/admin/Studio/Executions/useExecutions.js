import { useCallback, useEffect, useRef, useState } from 'react';
import { effectiveRunScope } from './runScope';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import scopedStorage from '../../../../utils/scopedStorage';

// Date-range chip → hours (0 = all time).
export const RANGE_HOURS = { '24h': 24, '7d': 168, '30d': 720, all: 0 };

// The chip values this UI can produce — also the allow-list for what may come
// back OUT of storage. Everything else is treated as never stored.
const STATUS_FILTERS = new Set(['all', 'running', 'awaiting', 'cancelled', 'error', 'success']);
const MODE_FILTERS = new Set(['live', 'test', 'both']);

// Map a status filter chip to the server status set. Closed on both ends:
// an unknown chip value maps to "no filter" rather than being forwarded to
// the server verbatim.
export function statusFilterToServer(status) {
    if (!status || status === 'all') return undefined;
    if (status === 'running') return ['running', 'queued'];
    if (status === 'awaiting') return ['awaiting_approval', 'awaiting_confirm', 'awaiting_form'];
    if (status === 'cancelled') return ['cancelled'];
    if (status === 'error' || status === 'success') return [status];
    return undefined;
}

const DEFAULT_FILTERS = { status: 'all', range: '24h', trigger: null, automationId: null, mode: 'live' };

/**
 * Validate a stored filter blob field by field — key AND value. Spreading
 * parsed JSON into state let unknown keys live forever (every setFilters
 * re-serialised them) and let unknown values leak into server queries. Only
 * the fields below, with a value this build understands, survive; anything
 * else falls back to DEFAULT_FILTERS via the merge. Returns null when there
 * is nothing valid to adopt. Never throws.
 */
export function sanitizeStoredFilters(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    if (typeof raw.status === 'string' && STATUS_FILTERS.has(raw.status)) out.status = raw.status;
    if (typeof raw.range === 'string' && Object.prototype.hasOwnProperty.call(RANGE_HOURS, raw.range)) out.range = raw.range;
    if (typeof raw.mode === 'string' && MODE_FILTERS.has(raw.mode)) out.mode = raw.mode;
    if (typeof raw.trigger === 'string' && raw.trigger) out.trigger = raw.trigger;
    if (typeof raw.automationId === 'string' && raw.automationId) out.automationId = raw.automationId;
    return Object.keys(out).length ? out : null;
}

/**
 * List-data hook for the executions table: cursor pagination, server-side
 * filters, facet counts, and live-event merging. De-dupes by run id and keeps
 * the list sorted newest-first so a live event and a later page can't double.
 *
 * scope: 'global' | 'automation' | 'step'. For automation/step the list is
 * fixed to that id; for global the user can filter by automation.
 *
 * runScope: 'mine' (default) | 'org' — WHOSE runs, a different question from
 * WHICH (see runScope.js). It is a PROP rather than one of the persisted
 * filters below on purpose: the filter blob is per-scope browser state that
 * outlives a permission, and a scope that could be restored from it would
 * quietly re-widen a list after the permission behind it was taken away. The
 * owning screen holds it, and every fetch below re-derives it through
 * effectiveRunScope so a stray 'org' cannot reach a per-routine surface.
 */
export default function useExecutions({ scope, automationId, stepId, runScope = 'mine', pageSize = 50, enabled = true }) {
    const api = useAutomationApi();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const [hasMore, setHasMore] = useState(false);
    const [facets, setFacets] = useState(null);
    const [filters, setFiltersState] = useState(DEFAULT_FILTERS);

    // Filters persist per scope — closing a run must not reset a
    // failures-last-7-days view someone set up. Rehydrated in an EFFECT, not
    // the lazy initializer: scopedStorage is a no-op until setCurrentUser has
    // run, and child effects fire before the parent's on first hydration.
    const hydratedRef = useRef(false);
    useEffect(() => {
        if (hydratedRef.current) return;
        hydratedRef.current = true;
        // getJSON only guarantees valid JSON — the allow-list parser decides
        // what of it is a filter. Spreading `stored` is safe because the
        // sanitizer built it from an explicit field list.
        const stored = sanitizeStoredFilters(scopedStorage.getJSON(`runsFilters.${scope}`, null));
        if (stored) {
            // Adopt-once cold-load sync — scopedStorage is a no-op until
            // setCurrentUser has run, so this can't live in the initializer.
            setFiltersState(prev => ({ ...prev, ...stored }));
        }
    }, [scope]);
    const setFilters = useCallback((updater) => {
        setFiltersState(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            try { scopedStorage.setItem(`runsFilters.${scope}`, JSON.stringify(next)); } catch { /* quota */ }
            return next;
        });
    }, [scope]);

    const cursorRef = useRef(null);
    const reqIdRef = useRef(0); // guards against out-of-order responses

    // Re-derived on every render rather than trusted as passed: 'org' is only
    // ever available on the global surface (runScope.js rule 2).
    const activeRunScope = effectiveRunScope(scope, runScope);

    const scopedAutomationId = scope === 'global' ? (filters.automationId || undefined) : (automationId || stepId);

    // Build the server query from the active filters.
    const queryFor = useCallback((cursor) => {
        const q = { limit: pageSize };
        if (cursor) q.cursor = cursor;
        const status = statusFilterToServer(filters.status);
        if (status) q.status = status;
        if (filters.trigger) q.trigger = filters.trigger;
        if (scopedAutomationId) q.automationId = scopedAutomationId;
        const hrs = RANGE_HOURS[filters.range] ?? 24;
        if (hrs > 0) q.since = new Date(Date.now() - hrs * 3600 * 1000).toISOString();
        // Default to production runs, with "Tests only" / "Live runs and
        // tests" one select away. THE STEP EXEMPTION IS LOAD-BEARING: a
        // Reusable Step's runs are ALL dry-runs — defaulting it to live
        // would empty the list entirely.
        if (scope !== 'step' && filters.mode !== 'both') q.mode = filters.mode || 'live';
        return q;
    }, [filters, scopedAutomationId, scope, pageSize]);

    const fetchPage = useCallback((q) => {
        // The org list is its own endpoint (403 without manage_automations,
        // 403 with no organisation) and it never silently narrows — so a
        // refusal surfaces on the error banner, where it belongs, instead of
        // becoming a shorter list nobody questions.
        if (scope === 'global') return activeRunScope === 'org' ? api.listOrgRuns(q) : api.listRecentRuns(q);
        if (scope === 'step') return api.listStepRuns(stepId, q);
        return api.listRuns(automationId, q);
    }, [api, scope, automationId, stepId, activeRunScope]);

    const refresh = useCallback(async () => {
        const myReq = ++reqIdRef.current;
        cursorRef.current = null;
        setLoading(true); setError(null);
        try {
            const res = await fetchPage(queryFor(null));
            if (myReq !== reqIdRef.current) return; // superseded
            setRows(res.runs || []);
            cursorRef.current = res.nextCursor || null;
            setHasMore(!!res.nextCursor);
        } catch (e) {
            if (myReq !== reqIdRef.current) return;
            setError(e); setRows([]); setHasMore(false);
        } finally {
            if (myReq === reqIdRef.current) setLoading(false);
        }
    }, [fetchPage, queryFor]);

    const loadMore = useCallback(async () => {
        if (!cursorRef.current || loadingMore) return;
        // Tie this page to the current request generation. A filter/scope
        // change (refresh) bumps reqIdRef; if that happens while this page is
        // in flight, its result belongs to the OLD filter — appending it would
        // mix stale rows into the fresh list and restore a stale cursor.
        const myReq = reqIdRef.current;
        setLoadingMore(true);
        try {
            const res = await fetchPage(queryFor(cursorRef.current));
            if (myReq !== reqIdRef.current) return; // superseded by a refresh
            setRows(prev => {
                const seen = new Set(prev.map(r => r.id));
                const fresh = (res.runs || []).filter(r => !seen.has(r.id));
                return [...prev, ...fresh];
            });
            cursorRef.current = res.nextCursor || null;
            setHasMore(!!res.nextCursor);
        } catch { /* keep current page on a paging error */ }
        finally { if (myReq === reqIdRef.current) setLoadingMore(false); }
    }, [fetchPage, queryFor, loadingMore]);

    // Reload when filters / scope change — but never while inactive: a
    // hidden-mounted panel (the builder keeps it mounted behind other views)
    // must not fetch until its first activation.
    const wasEnabledRef = useRef(false);
    useEffect(() => {
        if (!enabled) return;
        wasEnabledRef.current = true;
        refresh();
    }, [refresh, enabled]);

    // Facet counts for the chips (status/trigger breakdown within the date +
    // automation context). Best-effort — chips fall back to no counts on error.
    // NOT keyed on rows.length: that re-ran an unbounded server scan on every
    // appended page. The server clamps `range` to 720h — sending more is a
    // silent no-op, so the "All" chip keeps 720 and the bar labels it.
    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        const range = RANGE_HOURS[filters.range] ?? 24;
        const query = {
            range: range || 720,
            automationId: scopedAutomationId,
            mode: scope !== 'step' && filters.mode !== 'both' ? (filters.mode || 'live') : undefined,
        };
        const ask = activeRunScope === 'org' ? api.getOrgRunFacets(query) : api.getRunFacets(query);
        // Best-effort, and CLEARED on failure rather than left standing: the
        // facets drive the "Now running" strip as well as the chips, and a
        // strip drawn from the previous scope's numbers under the other
        // scope's heading is a wrong answer rather than a stale one.
        ask.then(r => { if (alive) setFacets(r.facets || null); }).catch(() => { if (alive) setFacets(null); });
        return () => { alive = false; };
    }, [api, filters.range, filters.mode, scopedAutomationId, scope, enabled, activeRunScope]);

    // Merge a live SSE event into the list. Respects the active filters so a
    // just-started run that doesn't match the status filter isn't injected.
    const applyEvent = useCallback((type, data) => {
        if (!data || !data.runId) return;
        if (type === 'step.started' || type === 'step.finished' || type === 'step.heartbeat') return;

        // Scope guard (global automation filter / per-automation surface).
        if (scopedAutomationId && data.automationId && data.automationId !== scopedAutomationId) return;

        // Events carry the LEG that fired them, but the list shows journeys: a
        // routine continued after a form pause runs in a child the table never
        // lists. Address the head, and never inject a leg as a row of its own —
        // its head is already there and would otherwise be duplicated.
        const rowId = data.rootRunId || data.runId;
        const isContinuation = !!data.rootRunId && data.rootRunId !== data.runId;

        setRows(prev => {
            const idx = prev.findIndex(r => r.id === rowId);
            if (type === 'run.started') {
                const statusOk = filters.status === 'all' || filters.status === 'running';
                if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = { ...next[idx], status: data.status || 'running' };
                    return next;
                }
                if (!statusOk || isContinuation) return prev; // don't inject a running row into a non-running filter, and never a leg
                const stub = {
                    id: rowId,
                    journeyRunId: data.runId,
                    automationId: data.automationId,
                    automationTitle: data.title || null,
                    automationKind: data.kind || 'automation',
                    triggerKind: data.triggerKind || null,
                    mode: data.mode || 'live',
                    status: data.status || 'running',
                    startedAt: data.at || new Date().toISOString(),
                    durationMs: null,
                };
                return [stub, ...prev];
            }
            // run.finished / run.failed → patch an existing row's terminal state.
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = {
                ...next[idx],
                journeyRunId: data.runId,
                status: data.status || next[idx].status,
                // A leg reports its OWN duration; the row measures the whole
                // journey, so only a self-contained run may set it here. The
                // next refetch carries the journey total either way.
                durationMs: isContinuation ? next[idx].durationMs : (data.durationMs ?? next[idx].durationMs),
                error: data.error ?? next[idx].error,
                errorClass: data.errorClass ?? next[idx].errorClass,
            };
            return next;
        });
    }, [filters.status, scopedAutomationId]);

    // Optimistic patch for ⋯ row actions.
    const patchRow = useCallback((id, partial) => {
        setRows(prev => prev.map(r => (r.id === id ? { ...r, ...partial } : r)));
    }, []);

    return {
        rows, loading, loadingMore, error, hasMore,
        loadMore, refresh,
        filters, setFilters,
        facets, applyEvent, patchRow,
        scopedAutomationId,
        // What the list ACTUALLY fetched, not what the caller asked for.
        runScope: activeRunScope,
    };
}
