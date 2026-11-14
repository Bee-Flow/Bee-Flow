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
// Hidden tab: no polling; back to visible: one refresh straight away (the
// query's interval and focus refetch, api/queries/shieldActivity.ts). A
// refresh keeps the data on screen until the new data is in (`loading` is
// only true before the first load), and a failed refresh keeps the old data
// rather than replacing the pane with an error.

import { useState } from 'react';
import { messageOf } from '@/utils/caughtError';
import { useShieldActivityQuery, type ShieldActivityRead, type ShieldFetched } from '@/api/queries/shieldActivity';

const DETAIL_LIMIT = 200;

const EMPTY_GUARD = { summary: {}, timeline: [], top_categories: [], by_action: [], top_users: [], by_surface: [], health: {} };
const EMPTY_INTEG = {
    summary: {}, timeline: [],
    top: { destinations: [], non_eu_destinations: [], integrations: [], actors: [], users: [] },
    pii_categories: [], data_categories: [], health: {},
    map: { origin: null, destinations: [], attribution: null, geo_db: null },
};

/** The window the tab asks about: explicit dates, or a number of days. */
interface RangeParams {
    startDate?: string | null;
    endDate?: string | null;
    days?: number | null;
    interval?: string | null;
}

type Raw = Record<string, unknown>;
type Guard = typeof EMPTY_GUARD;
type Integ = typeof EMPTY_INTEG;
type Read = ShieldActivityRead<Partial<Guard>, Partial<Integ>, Raw>;

function buildQS(rangeParams: RangeParams | null | undefined, extra: Raw = {}): string {
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
function mergeInteg(i: ShieldFetched<Partial<Integ>>): Integ {
    if (i.notFound) return EMPTY_INTEG;
    return {
        ...EMPTY_INTEG,
        ...i.data,
        top: { ...EMPTY_INTEG.top, ...(i.data?.top || {}) },
        map: { ...EMPTY_INTEG.map, ...(i.data?.map || {}) },
    };
}

const rowsOf = (r: ShieldFetched<Raw[]>): Raw[] => (r.notFound || !Array.isArray(r.data) ? [] : r.data);

/** What the pane shows of one window's answers. */
function shown(read: Read) {
    return {
        guard: read.guard.notFound ? EMPTY_GUARD : { ...EMPTY_GUARD, ...read.guard.data },
        integ: mergeInteg(read.integ),
        guardRows: rowsOf(read.guardRows),
        egressRows: rowsOf(read.egressRows),
    };
}

const NOTHING = { guard: EMPTY_GUARD, integ: EMPTY_INTEG, guardRows: [] as Raw[], egressRows: [] as Raw[] };

interface UseShieldActivityOptions {
    /** Fetch at all (licence + mount decide). */
    enabled: boolean;
    /** From deriveRangeParams, or `{ days }`. */
    rangeParams?: RangeParams | null;
    /** Detail-row cap per ledger. */
    limit?: number;
    /**
     * Also fetch the two detail ledgers. The editor's 30-day figures
     * (Overview, strip, checks, matrix) only need the two aggregates, so they
     * pass `false` and skip the row fetches.
     */
    detail?: boolean;
    /**
     * Refresh every 30 seconds while visible. Off for the editor's figures: a
     * posture summary does not need to move while you read it, and the "What
     * happened" pane has its own live copy.
     */
    poll?: boolean;
    /**
     * The organisation to read, sent as `?orgId`. Only a platform admin's
     * choice in the admin dashboard sets it; without it the server answers for
     * the caller's own organisation.
     */
    orgId?: string | null;
}

export default function useShieldActivity({ enabled, rangeParams, limit = DETAIL_LIMIT, detail = true, poll = true, orgId = null }: UseShieldActivityOptions) {
    const scope: Raw = orgId ? { orgId } : {};
    const query = useShieldActivityQuery<Partial<Guard>, Partial<Integ>, Raw>({
        enabled,
        overviewQuery: buildQS(rangeParams, scope),
        detailQuery: buildQS(rangeParams, { limit, ...scope }),
        detail,
        poll,
    });
    // The last answer that arrived stays on screen: through a refresh, through the
    // load of another window, and when either of those fails.
    const [held, setHeld] = useState<{ read: Read; view: typeof NOTHING } | null>(null);
    if (query.data && query.data !== held?.read) setHeld({ read: query.data, view: shown(query.data) });
    const fetching = enabled && query.isFetching;

    return {
        loading: fetching && !held,
        loaded: !!held,
        refreshing: fetching,
        error: enabled ? failureOf(query) : null,
        ...(held?.view ?? NOTHING),
        limit,
    };
}

/** Only a window that has no answer yet reports its failure, and not while it is asked again. */
function failureOf(query: { isError: boolean; isFetching: boolean; data: unknown; error: unknown }): string | null {
    if (!query.isError || query.isFetching || query.data !== undefined) return null;
    return messageOf(query.error, 'failed');
}
