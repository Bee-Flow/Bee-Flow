/**
 * Everything the "What happened" pane draws, derived from what it fetched and
 * the filters that are on. Pure, so the counting rules can be tested without
 * rendering; `useActivityView` only memoises it.
 *
 * The rule for every figure (shieldFilters.countMode): the server's totals
 * while no filter applies to it, the loaded rows once one does — never a mix.
 * A panel that IS one axis (the outcome pills, the day chart, a ranked list,
 * the map's kind pills and region groups, the destinations) ignores its own
 * axis, so choosing something there highlights it rather than emptying the
 * panel.
 */

import type { EgressMapFilters, KindCount, DestinationType } from './egressMap/egressMapContract';
import { isMarker } from './activityLabels';
import { carriesKinds, sumByAction, type ByActionRow } from './outcomes';
import { applyFilters, countMode, omitFilters, rank } from './shieldFilters';
import { deriveFindings, type Finding } from './shieldFindings';
import { destinationsFromRows } from './shieldRows';
import { daySpan } from './shieldDates';
import { sampleCoverage, type Coverage, type StreamRow } from './shieldStream';
import { aggregateTotals, daySeries, dayStacks, guardFinds, sampleTotals, type DayStack, type Totals } from './shieldTotals';
import type { Region } from '../shieldPalette';

type Filters = Record<string, unknown>;
type Raw = Record<string, unknown>;

type CategoryCount = { category?: string; violation_type?: string; count?: unknown };

export interface ViewInput {
    guard: Raw & { summary?: Raw; by_action?: ByActionRow[]; top_categories?: CategoryCount[]; window?: { start?: string | null; end?: string | null } | null };
    integ: Raw & { summary?: Raw; top?: { destinations?: Raw[] }; map?: { destinations?: Raw[] }; pii_categories?: CategoryCount[] };
    guardRows: Raw[];
    egressRows: Raw[];
    limit: number;
    rangeParams: { startDate?: string | null; endDate?: string | null; days?: number | null } | null;
    toolHoldBack?: { held: number; total: number } | null;
    thresholds: { score: number; catches: number };
    placeLabel: (row: Raw) => string;
}

export interface RankEntry { value: string; label: string; count: number }

export interface ActivityView {
    stream: StreamRow[];
    filtered: StreamRow[];
    sampled: boolean;
    coverage: Coverage;
    /** Where the per-day picture starts, when that is later than the window's start; else null. */
    chartSince: string | null;
    totals: Totals;
    /** The outcome breakdown, over every filter except the outcome. */
    inShort: Totals;
    findings: Finding[];
    days: string[];
    stacks: DayStack[];
    series: { steppedIn: number[]; found: number[]; tool: number[] };
    kinds: RankEntry[];
    /** `kinds` was counted over the loaded rows (a filter is on), not the whole window. */
    kindsSampled: boolean;
    places: RankEntry[];
    people: RankEntry[];
    mapDests: Raw[];
    listDests: Raw[];
    mapData: Omit<EgressMapFilters, 'selectedKind' | 'onSelectKind' | 'selectedRegion' | 'onSelectRegion' | 'catLabel'>;
    window: { start: string; end: string };
    empty: boolean;
}

const num = (v: unknown): number => Number(v) || 0;
const DAY_MS = 86_400_000;

/** Figures over `filters`: the aggregate when none applies, else counted over the rows. */
function totalsFor(input: ViewInput, stream: StreamRow[], filters: Filters): Totals {
    return countMode(filters) === 'aggregate'
        ? aggregateTotals(input.guard, input.integ)
        : sampleTotals(applyFilters(stream, filters));
}

function windowOf(input: ViewInput): { start: string; end: string } {
    const end = input.guard.window?.end || input.rangeParams?.endDate || new Date().toISOString();
    const start = input.guard.window?.start || input.rangeParams?.startDate
        || new Date(new Date(end).getTime() - (input.rangeParams?.days || 30) * DAY_MS).toISOString();
    return { start, end };
}

/** The rows the per-day pictures may use: before `since`, one ledger may be missing. */
function chartRows(rows: StreamRow[], since: string | null): StreamRow[] {
    if (!since) return rows;
    const from = new Date(since).getTime();
    return rows.filter(r => new Date(r.ts).getTime() >= from);
}

/**
 * The window's kinds of personal data per category, from the server's
 * rollups: the shield's (audit rows, notes, failed checks and markers left
 * out, one category summed over its violation types) and the calls'.
 */
function windowKinds(categories: CategoryCount[][]): Array<{ value: string; count: number }> {
    const counts = new Map<string, number>();
    for (const list of categories) {
        for (const c of list) {
            const id = String(c.category || '').trim();
            if (!id || isMarker(id) || (c.violation_type !== undefined && !carriesKinds(c.violation_type))) continue;
            counts.set(id, (counts.get(id) || 0) + num(c.count));
        }
    }
    return [...counts.entries()]
        .filter(([, n]) => n > 0)
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }));
}

function ranks(input: ViewInput, stream: StreamRow[], filters: Filters, catLabel: (id: string) => string) {
    const over = (axis: string): StreamRow[] => applyFilters(stream, omitFilters(filters, [axis]));
    const personLabel = new Map(stream.map(r => [r.person, r.personLabel || r.person]));
    // Both modes rank kinds FOUND (markers left out), so a filter never makes
    // "Protection was unavailable" appear as a kind. Markers stay filterable
    // from the log's chips.
    // Unfiltered, the kinds are the window's (the rows are at most the latest
    // 200 per ledger); places and people have no window-wide rollup at this
    // grain, so the pane says when they are counted over a capped sample.
    const kindsSampled = countMode(omitFilters(filters, ['kind'])) === 'sample';
    const kinds = kindsSampled
        ? rank(over('kind'), (r: StreamRow) => r.found, 7)
        : windowKinds([input.guard.top_categories || [], input.integ.pii_categories || []]).slice(0, 7);
    return {
        kinds: kinds.map(({ value, count }: { value: string; count: number }) => ({ value, label: catLabel(value), count })),
        kindsSampled,
        places: rank(over('place'), (r: StreamRow) => r.place, 5)
            .map(({ value, count }: { value: string; count: number }) => ({ value, label: value, count })),
        people: rank(over('person').filter(r => r.found.length > 0), (r: StreamRow) => r.person, 5)
            .map(({ value, count }: { value: string; count: number }) => ({ value, label: personLabel.get(value) || value, count })),
    };
}

/** Per host, the kinds found in its calls ([id, n], most first). */
function kindsPerHost(rows: StreamRow[]): Record<string, Array<[string, number]>> {
    const byHost = new Map<string, Map<string, number>>();
    for (const r of rows) {
        if (!r.dest) continue;
        const kinds = byHost.get(r.dest) || new Map<string, number>();
        for (const k of r.kinds) kinds.set(k, (kinds.get(k) || 0) + 1);
        byHost.set(r.dest, kinds);
    }
    return Object.fromEntries([...byHost.entries()].map(([host, kinds]) => [
        host, [...kinds.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])),
    ]));
}

/** Per host, what its sampled calls mostly were. */
function typesPerHost(rows: StreamRow[]): Record<string, DestinationType> {
    const votes = new Map<string, { tool: number; web_search: number }>();
    for (const r of rows) {
        if (!r.dest) continue;
        const v = votes.get(r.dest) || { tool: 0, web_search: 0 };
        if (r.entry === 'web_search') v.web_search += 1; else v.tool += 1;
        votes.set(r.dest, v);
    }
    return Object.fromEntries([...votes.entries()].map(([host, v]) => [host, v.web_search > v.tool ? 'web_search' : 'tool']));
}

function mapData(input: ViewInput, stream: StreamRow[], filters: Filters, catLabel: (id: string) => string): ActivityView['mapData'] {
    const calls = stream.filter(r => r.source === 'egress');
    const kindFilters = omitFilters(filters, ['kind', 'dest']);
    const base = applyFilters(calls, kindFilters);
    const regionBase = omitFilters(filters, ['dest', 'region']);
    // The pills' counts are the window's calls while nothing else is chosen;
    // `hostKinds` (the pins' grey-out and the tooltip) stays per sampled host.
    const counted = countMode(kindFilters) === 'aggregate'
        ? windowKinds([input.integ.pii_categories || []])
        : rank(base, (r: StreamRow) => r.found, 100);
    const kindCounts: KindCount[] = counted
        .map(({ value, count }: { value: string; count: number }) => ({ id: value, label: catLabel(value), n: count }));
    const regionTotals: Record<Region, number> = countMode(regionBase) === 'aggregate'
        ? aggregateTotals(input.guard, input.integ).regions
        : sampleTotals(applyFilters(calls, regionBase)).regions;
    return { kindCounts, hostKinds: kindsPerHost(base), hostTypes: typesPerHost(calls), regionTotals };
}

/**
 * The map's pins and the destination list. Both ignore their own axes (the
 * destination and the region): choosing one highlights it rather than
 * emptying the map and the list. The pins also ignore the kind, so the ones
 * that did not carry it turn grey instead of disappearing (`hostKinds` only
 * knows the sampled hosts, so a kind keeps the sample as the base).
 */
function destinations(input: ViewInput, stream: StreamRow[], filters: Filters) {
    const base = omitFilters(filters, ['dest', 'region']);
    if (countMode(base) === 'aggregate') {
        const top = (input.integ.top?.destinations || []).slice(0, 12);
        const all = input.integ.map?.destinations;
        return { mapDests: Array.isArray(all) && all.length ? all : top, listDests: top };
    }
    const calls = stream.filter(r => r.source === 'egress');
    const pins = applyFilters(calls, omitFilters(base, ['kind']));
    return { mapDests: destinationsFromRows(pins, 200), listDests: destinationsFromRows(applyFilters(calls, base), 12) };
}

function findingsFor(input: ViewInput): Finding[] {
    const acted = sumByAction(input.guard.by_action);
    return deriveFindings({
        summary: input.integ.summary || {},
        destinations: (input.integ.map?.destinations?.length ? input.integ.map.destinations : input.integ.top?.destinations) || [],
        guardPiiCount: guardFinds(input.guard.summary),
        stayedPct: aggregateTotals(input.guard, input.integ).stayedPct,
        ...acted,
        toolHoldBack: input.toolHoldBack,
        scoreThreshold: input.thresholds.score,
        catchesThreshold: input.thresholds.catches,
    });
}

function perDay(stream: StreamRow[], filters: Filters, days: string[], since: string | null) {
    const rows = chartRows(applyFilters(stream, omitFilters(filters, ['day'])), since);
    return {
        stacks: dayStacks(rows, days),
        series: {
            steppedIn: daySeries(rows, days, r => r.outcome === 'replaced' || r.outcome === 'stopped'),
            found: daySeries(rows, days, r => r.found.length > 0),
            tool: daySeries(rows, days, r => r.outcome === 'tool'),
        },
    };
}

/** The whole view, from the stream (built once per fetch) and the filters. */
export function buildView(input: ViewInput, stream: StreamRow[], filters: Filters, catLabel: (id: string) => string): ActivityView {
    const filtered = applyFilters(stream, filters);
    const sampled = countMode(filters) === 'sample';
    const coverage = sampleCoverage({
        guardRows: input.guardRows, egressRows: input.egressRows, limit: input.limit,
        guardTotal: num(input.guard.summary?.total_events), egressTotal: num(input.integ.summary?.total_calls),
    });
    const win = windowOf(input);
    const days = daySpan(win.start, win.end);
    const chartSince = coverage.since && new Date(coverage.since).getTime() > new Date(win.start).getTime() ? coverage.since : null;
    return {
        stream,
        filtered,
        sampled,
        coverage,
        chartSince,
        totals: totalsFor(input, stream, filters),
        inShort: totalsFor(input, stream, omitFilters(filters, ['outcome'])),
        findings: findingsFor(input),
        days,
        ...perDay(stream, filters, days, chartSince),
        ...ranks(input, stream, filters, catLabel),
        ...destinations(input, stream, filters),
        mapData: mapData(input, stream, filters, catLabel),
        window: win,
        empty: stream.length === 0 && input.guardRows.length === 0
            && num(input.guard.summary?.total_events) === 0 && num(input.integ.summary?.total_calls) === 0,
    };
}
