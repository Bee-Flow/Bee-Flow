/**
 * The run log's filters and scope, as pure functions — the phone's half of
 * the web's useExecutions.js (the server query), ExecutionsFilterBar.jsx (the
 * chips and their counts) and runScope.js (whose runs, and which may open).
 * filters.test.ts pins the query each filter sends.
 */

import type { QueryParams } from '@/core/api/client';

import type { LogRun, RunFacets, RunScope } from './types';

export const STATUS_CHIPS = ['all', 'success', 'error', 'running', 'awaiting', 'cancelled'] as const;
export type StatusChip = (typeof STATUS_CHIPS)[number];

/** Date-range chip → hours; 0 is all time. */
export const RANGE_HOURS = { '24h': 24, '7d': 168, '30d': 720, all: 0 } as const;
export type RangeKey = keyof typeof RANGE_HOURS;
export const RANGES = Object.keys(RANGE_HOURS) as RangeKey[];

export const MODES = ['live', 'dry_run', 'both'] as const;
export type ModeFilter = (typeof MODES)[number];

export interface RunFilters {
    status: StatusChip;
    range: RangeKey;
    trigger: string | null;
    automationId: string | null;
    mode: ModeFilter;
}

export const DEFAULT_FILTERS: RunFilters = Object.freeze({
    status: 'all',
    range: '24h',
    trigger: null,
    automationId: null,
    mode: 'live',
});

/** The list's page size — the web's. */
export const RUN_PAGE_SIZE = 50;

/** A chip → the server's status set. Closed both ways: an unknown chip filters nothing. */
export function statusFilterToServer(status: string | null | undefined): string[] | undefined {
    if (!status || status === 'all') return undefined;
    if (status === 'running') return ['running', 'queued'];
    if (status === 'awaiting') return ['awaiting_approval', 'awaiting_confirm', 'awaiting_form'];
    if (status === 'cancelled') return ['cancelled'];
    if (status === 'error' || status === 'success') return [status];
    return undefined;
}

/**
 * The list query for one page. Production runs by default, "tests only" and
 * "both" one choice away — the same default as the web's global view.
 */
export function runQuery(filters: RunFilters, cursor: string | null, now = Date.now()): QueryParams {
    const q: QueryParams = { limit: RUN_PAGE_SIZE };
    if (cursor) q.cursor = cursor;
    const status = statusFilterToServer(filters.status);
    if (status) q.status = status.join(',');
    if (filters.trigger) q.trigger = filters.trigger;
    if (filters.automationId) q.automationId = filters.automationId;
    const hours = RANGE_HOURS[filters.range] ?? 24;
    if (hours > 0) q.since = new Date(now - hours * 3600 * 1000).toISOString();
    if (filters.mode !== 'both') q.mode = filters.mode || 'live';
    return q;
}

/** The count a status chip wears, from the facets; null while there are none. */
export function statusCount(facets: RunFacets | null | undefined, chip: StatusChip): number | null {
    const s = facets?.status;
    if (!s) return null;
    if (chip === 'all') return Object.values(s).reduce((a, b) => a + b, 0);
    if (chip === 'running') return (s.running || 0) + (s.queued || 0);
    if (chip === 'awaiting') return (s.awaiting_approval || 0) + (s.awaiting_confirm || 0) + (s.awaiting_form || 0);
    return s[chip] || 0;
}

/** True when anything narrows the list beyond the default "everything, all time". */
export function isNarrowed(filters: RunFilters): boolean {
    return (
        filters.status !== 'all' ||
        filters.range !== 'all' ||
        Boolean(filters.trigger) ||
        Boolean(filters.automationId) ||
        filters.mode !== 'both'
    );
}

/** The web's "Show everything": no status, all time, any trigger, live and tests. */
export const EVERYTHING: RunFilters = Object.freeze({
    status: 'all',
    range: 'all',
    trigger: null,
    automationId: null,
    mode: 'both',
});

/** Anything at all → a scope; only the exact string 'org' widens it. */
export function normaliseRunScope(value: unknown): RunScope {
    return value === 'org' ? 'org' : 'mine';
}

/**
 * May this row be opened? Every per-run route is scoped to the run's owner,
 * so in the org scope only a row the server stamped `mine: true` opens — an
 * absent stamp is a server that did not say, not permission.
 */
export function canOpenRun(scope: RunScope, run: Pick<LogRun, 'mine'>): boolean {
    return normaliseRunScope(scope) === 'org' ? run.mine === true : true;
}

/** The phone's run screen for a row — the run the row names, as the web's `?run=` link does. */
export function runHref(run: Pick<LogRun, 'id' | 'automationId'>): string {
    return `/automations/${encodeURIComponent(run.automationId)}/runs?runId=${encodeURIComponent(run.id)}`;
}
