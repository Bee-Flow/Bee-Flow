// Data layer for the Privacy Shield "What happened" tab.
//
// Fetches ONLY when the tab is active and the licence allows it — unlike the
// old Usage & Monitoring page, which fired all 31 endpoints on mount
// regardless of the visible tab.
//
// Server contract (server/routes/usage.js — both admin-gated, dry runs
// excluded, org from the session):
//   GET /api/usage/guardrails/overview    → { summary, timeline, top_categories,
//                                            by_action, top_users, health, window }
//   GET /api/usage/integrations/overview  → { summary(+sovereignty_score/score_delta),
//                                            timeline, top{destinations,non_eu_destinations,
//                                            integrations,actors,users}, pii_categories,
//                                            data_categories, health, window }
//   GET /api/usage/guardrails/recent?limit=&type=&user=
//   GET /api/usage/integrations/egress?limit=&eu=&user=&integration=&pii=
//
// This hook sends only the window and the row cap: never `user` and never
// `pii`. Every filter runs over the rows held. The server refuses a health
// category (`pii`) next to a person (`user`, or a route that lists people)
// with 400 special_category_per_person, and strips health labels from every
// row that carries a user (core/privacy/specialCategories.js).
//
// ── Why the detail rows load UP FRONT now ────────────────────────────────
// The tab became one cross-filter: clicking a KPI, a bar, a person, a place, a
// destination or a category chip narrows every panel at once. That is only
// possible over rows we hold, so both detail arrays are fetched with the
// overviews rather than lazily when a fold opens. Two extra requests, once per
// window, in exchange for a tab where nothing needs a round trip to filter.
//
// ── And why the aggregates are STILL fetched ─────────────────────────────
// The detail endpoints cap at 200 rows; the overviews aggregate server-side
// over the whole window. For a busy organisation those are different numbers,
// and the 200-row sample is a floor. So: aggregates drive the unfiltered
// headline figures (correct for the window), the sample drives everything once
// a filter is on, and the UI says which it is showing — see
// shieldFilters.countMode / isCapped. Deriving the headline score from a
// sample is the exact bug the server-side score was introduced to fix; this
// must not quietly reintroduce it.
//
// A 404 is treated as EMPTY (a stack whose API predates these endpoints shows
// the empty state, not an error); a network failure sets `error`.
//
// ── Live while you look ──────────────────────────────────────────────────
// Every 30 seconds while the browser tab is visible the four requests run
// again, so a call an automation just made shows up on the map without a reload.
// Hidden tab: no polling; back to visible: one refresh straight away. A
// refresh keeps the data on screen until the new data is in (`loading` is
// only true before the first load), and a failed refresh keeps the old data
// rather than replacing the pane with an error.

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../../../../../../utils/helpers';

const DETAIL_LIMIT = 200;
const REFRESH_MS = 30_000;

const EMPTY_GUARD = { summary: {}, timeline: [], top_categories: [], by_action: [], top_users: [], by_surface: [], health: {} };
const EMPTY_INTEG = {
    summary: {}, timeline: [],
    top: { destinations: [], non_eu_destinations: [], integrations: [], actors: [], users: [] },
    pii_categories: [], data_categories: [], health: {},
    map: { origin: null, destinations: [], attribution: null, geo_db: null },
};

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function buildQS(rangeParams, extra = {}) {
    const qs = new URLSearchParams();
    if (rangeParams?.startDate && rangeParams?.endDate) {
        qs.set('startDate', rangeParams.startDate);
        qs.set('endDate', rangeParams.endDate);
    } else if (rangeParams?.days) {
        qs.set('days', String(rangeParams.days));
    }
    if (rangeParams?.interval) qs.set('interval', rangeParams.interval);
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `?${s}` : '';
}

/** An overview response over the empty shape, so a key an older server omits reads as empty. */
function mergeInteg(i) {
    if (i.notFound) return EMPTY_INTEG;
    return {
        ...EMPTY_INTEG,
        ...i.data,
        top: { ...EMPTY_INTEG.top, ...(i.data?.top || {}) },
        map: { ...EMPTY_INTEG.map, ...(i.data?.map || {}) },
    };
}

const rowsOf = (r) => (r.notFound || !Array.isArray(r.data) ? [] : r.data);

async function fetchJson(url) {
    const res = await authFetch(url);
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json() };
}

/**
 * @param {object}  opts
 * @param {boolean} opts.enabled      Fetch at all (licence + mount decide).
 * @param {object}  opts.rangeParams  From deriveRangeParams, or `{ days }`.
 * @param {number}  [opts.limit]      Detail-row cap per ledger.
 * @param {boolean} [opts.detail]     Also fetch the two detail ledgers. The
 *   editor's 30-day figures (Overview, strip, checks, matrix) only need the
 *   two aggregates, so they pass `false` and skip the row fetches.
 * @param {boolean} [opts.poll]       Refresh every 30 seconds while visible.
 *   Off for the editor's figures: a posture summary does not need to move
 *   while you read it, and the "What happened" pane has its own live copy.
 */
export default function useShieldActivity({ enabled, rangeParams, limit = DETAIL_LIMIT, detail = true, poll = true }) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [guard, setGuard] = useState(EMPTY_GUARD);
    const [integ, setInteg] = useState(EMPTY_INTEG);
    const [guardRows, setGuardRows] = useState([]);
    const [egressRows, setEgressRows] = useState([]);
    const loadedOnce = useRef(false);
    // State twin of `loadedOnce`, for callers that must tell "no data yet"
    // from "the data is zero" during render (a ref read there is stale).
    const [loaded, setLoaded] = useState(false);
    const loadedRange = useRef('');
    const [tick, setTick] = useState(0);

    // The refresh clock: runs only while the tab is visible and the pane is on.
    useEffect(() => {
        if (!enabled || !poll || typeof document === 'undefined') return undefined;
        let timer = null;
        const start = () => { if (!timer) timer = setInterval(() => setTick(n => n + 1), REFRESH_MS); };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        const onVisibility = () => {
            if (isVisible()) { setTick(n => n + 1); start(); } else stop();
        };
        if (isVisible()) start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
    }, [enabled, poll]);

    // rangeParams is derived fresh each render — the effect is keyed on its
    // meaningful bits and reads the current object through an Effect Event.
    const currentRange = useEffectEvent(() => rangeParams);
    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const range = currentRange();
        const rangeKey = buildQS(range, { limit });
        // A refresh of what is already on screen, as opposed to a first load
        // or a new range: its failure must not blank the pane.
        const refresh = loadedOnce.current && loadedRange.current === rangeKey;
        setLoading(true);
        if (!refresh) setError(null);
        (async () => {
            try {
                const none = Promise.resolve({ notFound: true });
                const [g, i, gr, er] = await Promise.all([
                    fetchJson(`${API_BASE}/api/usage/guardrails/overview${buildQS(range)}`),
                    fetchJson(`${API_BASE}/api/usage/integrations/overview${buildQS(range)}`),
                    detail ? fetchJson(`${API_BASE}/api/usage/guardrails/recent${buildQS(range, { limit })}`) : none,
                    detail ? fetchJson(`${API_BASE}/api/usage/integrations/egress${buildQS(range, { limit })}`) : none,
                ]);
                if (cancelled) return;
                setGuard(g.notFound ? EMPTY_GUARD : { ...EMPTY_GUARD, ...g.data });
                setInteg(mergeInteg(i));
                setGuardRows(rowsOf(gr));
                setEgressRows(rowsOf(er));
                loadedOnce.current = true;
                loadedRange.current = rangeKey;
                setLoaded(true);
                setError(null);
            } catch (e) {
                if (!cancelled && !refresh) setError(e.message || 'failed');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [enabled, detail, limit, tick, rangeParams?.startDate, rangeParams?.endDate, rangeParams?.days, rangeParams?.interval]);

    return {
        loading: loading && !loadedOnce.current,
        loaded,
        refreshing: loading,
        error,
        guard,
        integ,
        guardRows,
        egressRows,
        limit,
    };
}
