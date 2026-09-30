/**
 * What one Solutions-overview card says, decided in one place — a port of the
 * web's admin/Studio/Solutions/solutionOverviewModel.js, held to it by
 * overview.lockstep.test.ts (the web module and this one on the same rows).
 *
 * Every function returns a STATE, never a sentence; the card renders the state
 * through `t()`. And every state that means "we do not know" is its own state:
 * a tally nobody could read must never paint as a 0, and a check that did not
 * run must never paint as a green tick.
 */

import type { KindKey } from '@/shared/ui';

import type { SolutionRow } from './solution';
import { COUNTED_SECTIONS } from './words';

export type OverviewTab = 'ours' | 'installed';

/** Which project tab a row belongs to: did it come out of a Blueprint. Total by construction. */
export function tabOf(row: Pick<SolutionRow, 'installedFromBlueprintId'>): OverviewTab {
    return row.installedFromBlueprintId ? 'installed' : 'ours';
}

/** The rows, split over the two project tabs. Every row lands in exactly one. */
export function partitionSolutions(rows: readonly SolutionRow[]): { ours: SolutionRow[]; installed: SolutionRow[] } {
    const ours: SolutionRow[] = [];
    const installed: SolutionRow[] = [];
    for (const row of rows) (tabOf(row) === 'installed' ? installed : ours).push(row);
    return { ours, installed };
}

export type HealthState = 'unknown' | 'unread' | 'blocking' | 'advice' | 'clear';

/**
 * The health chip. `unread` outranks `blocking`: a count derived from a
 * partial read is misleading precision, so the card says the picture is
 * incomplete and withholds the number. `clear` is reachable only from
 * `complete === true` with nothing found.
 */
export function healthOf(row: Pick<SolutionRow, 'completeness'>): { state: HealthState; count: number } {
    const c = row.completeness;
    if (!c) return { state: 'unknown', count: 0 };
    if (c.complete !== true) return { state: 'unread', count: 0 };
    if (c.errors > 0) return { state: 'blocking', count: c.errors };
    if (c.warnings > 0) return { state: 'advice', count: c.warnings };
    if (c.findings > 0) return { state: 'advice', count: c.findings };
    return { state: 'clear', count: 0 };
}

export type RunsState = 'unknown' | 'failed' | 'ran' | 'idle';

/** The run line: `idle` is a read zero, `unknown` could not be counted — never the same. */
export function runsOf(row: Pick<SolutionRow, 'runs'>): { state: RunsState; today: number | null; failed: number | null } {
    const runs = row.runs;
    if (!runs || runs.today === null || runs.failed === null) return { state: 'unknown', today: null, failed: null };
    const { today, failed } = runs;
    if (failed > 0) return { state: 'failed', today, failed };
    if (today > 0) return { state: 'ran', today, failed };
    return { state: 'idle', today, failed };
}

/**
 * One chip per kind this Solution holds, plus the kinds whose count could not
 * be read. A null count is NOT a chip and NOT a zero: it goes on `unreadable`,
 * which the card prints as a named gap. A 0 gets no chip for the opposite
 * reason — the server answered, and "no apps" is not worth a chip.
 */
export function chipsOf(row: Pick<SolutionRow, 'counts'>): {
    chips: { section: string; kind: KindKey; count: number }[];
    unreadable: string[];
} {
    const chips: { section: string; kind: KindKey; count: number }[] = [];
    const unreadable: string[] = [];
    for (const { section, kind } of COUNTED_SECTIONS) {
        const n = row.counts[section];
        if (n === null || n === undefined || !Number.isFinite(n)) unreadable.push(section);
        else if (n > 0) chips.push({ section, kind, count: n });
    }
    return { chips, unreadable };
}

export type UpdateState = 'available' | 'current' | 'unknown';

/**
 * Whether a newer Blueprint exists, for a Solution that came from one; null
 * when it did not. `unknown` is NOT "up to date".
 */
export function updateOf(row: Pick<SolutionRow, 'update'>): {
    state: UpdateState;
    installedVersion: number | null;
    latestVersion: number | null;
} | null {
    const update = row.update;
    if (!update) return null;
    const { installedVersion } = update;
    if (update.available === true) return { state: 'available', installedVersion, latestVersion: update.latestVersion };
    if (update.available === false) return { state: 'current', installedVersion, latestVersion: update.latestVersion };
    return { state: 'unknown', installedVersion, latestVersion: null };
}
