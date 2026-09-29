/**
 * The figures on the "What happened" pane, from ONE source at a time.
 *
 *   aggregate  no filter is on: the server's totals over the whole window.
 *   sample     a filter is on: counted over the fetched rows (≤200 per
 *              ledger), which the pane labels as a sample when it is capped.
 *
 * Never mixed within one figure — see shieldFilters.countMode. Both builders
 * return the same shape, so a panel does not know or care which it got.
 *
 * ── What the aggregate can and cannot say ─────────────────────────────────
 * Messages the shield found nothing in are NOT logged, so there is no count
 * of "messages checked" and no "clean message" bucket: `clean` is about calls
 * to outside services only, and only the calls that were scanned — the rest
 * are `unchecked`. `findings` sums the per-category counts, and the shield's
 * list of categories is the server's top 10, so with ten entries the sum is a
 * floor (`findingsFloor`).
 *
 * "Personal data found N — in M messages and calls" counts N and M over the
 * SAME rows: shield events whose categories column can name a find (not a
 * failed check, not a note, not an audit row), and calls that carried data.
 * Audit markers ("protection was unavailable") are never a find.
 */

import { isMarker } from './activityLabels';
import { OUTCOME_ORDER, carriesKinds, isAuditRow, outcomeOfAction, sumByAction, type ByActionRow, type Outcome } from './outcomes';
import type { StreamRow } from './shieldStream';
import { REGION_ORDER, type Region } from '../shieldPalette';

export interface Totals {
    /** Times the shield acted on a message (audit rows excluded). */
    events: number;
    /** Calls to outside services. */
    calls: number;
    outcomes: Record<Outcome, number>;
    /** Pieces of personal data found (one message can carry several). */
    findings: number;
    /** `findings` is a lower bound (the server lists the top 10 categories only). */
    findingsFloor: boolean;
    /** Messages and calls that carried personal data. */
    withPersonalData: number;
    /** Calls that left with personal data AND went to a server outside Europe. */
    toolOutside: number;
    /** Calls per region. */
    regions: Record<Region, number>;
    /** Share of PLACED calls that stayed on your server or in Europe; null when none was placed. */
    stayedPct: number | null;
}

interface Summary { [key: string]: unknown }
interface GuardOverview {
    summary?: Summary;
    by_action?: ByActionRow[];
    top_categories?: Array<{ category?: string; violation_type?: string; count?: unknown }>;
}
interface IntegOverview {
    summary?: Summary;
    pii_categories?: Array<{ category?: string; count?: unknown }>;
}

const num = (v: unknown): number => Number(v) || 0;

const zeroOutcomes = (): Record<Outcome, number> =>
    Object.fromEntries(OUTCOME_ORDER.map(o => [o, 0])) as Record<Outcome, number>;
const zeroRegions = (): Record<Region, number> =>
    Object.fromEntries(REGION_ORDER.map(r => [r, 0])) as Record<Region, number>;

/**
 * Your own server and inside Europe, as a share of every call whose place is
 * known. Never rounded to a claim the data contradicts: one call outside
 * Europe in a thousand is 99%, not 100%, and one that stayed is 1%, not 0%.
 */
export function stayedInEurope(regions: Record<Region, number>): number | null {
    const stayed = regions.local + regions.eu;
    const placed = stayed + regions.outside;
    if (placed <= 0) return null;
    const pct = Math.round((100 * stayed) / placed);
    if (regions.outside > 0 && pct === 100) return 99;
    if (stayed > 0 && pct === 0) return 1;
    return pct;
}

/** Shield events whose action is none of the known ones — shown, never guessed into a bucket. */
function otherEvents(rows: ByActionRow[] | undefined): number {
    return (rows || []).reduce((n, row) => (
        !isAuditRow(row) && outcomeOfAction(row.action_taken, row.violation_type) === 'other' ? n + num(row.count) : n
    ), 0);
}

/**
 * Calls per outcome. `clean_count` and `unchecked_count` come from the server
 * (a blocked call is in neither: its stop is counted once, from the shield's
 * own event). An older server sends neither; every call without a find is
 * then read as clean, as it always was.
 */
function callOutcomes(is: Summary): { tool: number; clean: number; unchecked: number } {
    const calls = num(is.total_calls);
    const tool = num(is.pii_events);
    if (is.clean_count === undefined && is.unchecked_count === undefined) {
        return { tool, clean: Math.max(0, calls - tool - num(is.blocked_count)), unchecked: 0 };
    }
    return { tool, clean: num(is.clean_count), unchecked: num(is.unchecked_count) };
}

/** Shield events that name a find: `pii_messages` from the server, `pii_count` from an older one. */
export function guardFinds(summary: Summary | null | undefined): number {
    const s = summary || {};
    return num(s.pii_messages !== undefined ? s.pii_messages : s.pii_count);
}

/** The server's window-wide totals. */
export function aggregateTotals(guard: GuardOverview | null | undefined, integ: IntegOverview | null | undefined): Totals {
    const gs = guard?.summary || {};
    const is = integ?.summary || {};
    const acted = sumByAction(guard?.by_action);
    const other = otherEvents(guard?.by_action);
    const calls = num(is.total_calls);
    const { tool, clean, unchecked } = callOutcomes(is);
    const categories = (guard?.top_categories || []).filter(c => carriesKinds(c.violation_type) && !isMarker(String(c.category || '')));
    const regions: Record<Region, number> = {
        local: num(is.local_count),
        eu: num(is.eu_count),
        outside: num(is.non_eu_count),
        via_network: num(is.via_network_count),
        unknown: num(is.unknown_count),
    };
    return {
        events: acted.replaced + acted.stopped + acted.passed + other,
        calls,
        outcomes: { ...zeroOutcomes(), ...acted, other, tool, clean, unchecked },
        findings: categories.reduce((n, c) => n + num(c.count), 0)
            + (integ?.pii_categories || []).filter(c => !isMarker(String(c.category || ''))).reduce((n, c) => n + num(c.count), 0),
        findingsFloor: (guard?.top_categories || []).length >= 10,
        withPersonalData: guardFinds(gs) + tool,
        toolOutside: num(is.pii_non_eu_count),
        regions,
        stayedPct: stayedInEurope(regions),
    };
}

/** The same figures, counted over rows. */
export function sampleTotals(rows: StreamRow[]): Totals {
    const outcomes = zeroOutcomes();
    const regions = zeroRegions();
    let events = 0;
    let calls = 0;
    let findings = 0;
    let withPersonalData = 0;
    let toolOutside = 0;
    for (const row of rows) {
        outcomes[row.outcome] += 1;
        findings += row.found.length;
        if (row.found.length > 0) withPersonalData += 1;
        if (row.source === 'guard') { events += 1; continue; }
        calls += 1;
        if (row.region) regions[row.region] += 1;
        if (row.outcome === 'tool' && row.region === 'outside') toolOutside += 1;
    }
    return {
        events, calls, outcomes, findings, findingsFloor: false, withPersonalData, toolOutside,
        regions, stayedPct: stayedInEurope(regions),
    };
}

/* ── Per day ─────────────────────────────────────────────────────────── */

export interface DayStack {
    day: string;
    total: number;
    outcomes: Record<Outcome, number>;
}

/** Rows per day and outcome, one entry for every day in `days` (empty days included). */
export function dayStacks(rows: StreamRow[], days: string[]): DayStack[] {
    const byDay = new Map(days.map(day => [day, { day, total: 0, outcomes: zeroOutcomes() }]));
    for (const row of rows) {
        const stack = row.day ? byDay.get(row.day) : undefined;
        if (!stack) continue;
        stack.total += 1;
        stack.outcomes[row.outcome] += 1;
    }
    return days.map(day => byDay.get(day) as DayStack);
}

/** Rows per day that pass `pick`, for a KPI's sparkline. */
export function daySeries(rows: StreamRow[], days: string[], pick: (row: StreamRow) => boolean): number[] {
    const index = new Map(days.map((day, i) => [day, i]));
    const out = days.map(() => 0);
    for (const row of rows) {
        const i = row.day ? index.get(row.day) : undefined;
        if (i !== undefined && pick(row)) out[i] += 1;
    }
    return out;
}

/** The busiest day; null when every day is empty. */
export function peakDay(stacks: DayStack[]): DayStack | null {
    let best: DayStack | null = null;
    for (const s of stacks) if (s.total > 0 && (!best || s.total > best.total)) best = s;
    return best;
}

/** The chart's y-axis top: at least 4, rounded up to a multiple of 4 so the midline is a whole number. */
export function axisMax(stacks: DayStack[]): number {
    const max = Math.max(4, ...stacks.map(s => s.total));
    return Math.ceil(max / 4) * 4;
}

/** Which bars get a date under them: every `step` days, counted back from the last one. */
export function labelStep(dayCount: number): number {
    if (dayCount <= 10) return 1;
    if (dayCount <= 45) return 5;
    return 15;
}
