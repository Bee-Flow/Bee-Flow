/**
 * A register's filter pills as data: which option of each group is active,
 * how many rows each option would leave, and whether a row passes (the
 * active options of all groups are ANDed).
 */

import type { Rec, RecordFilterGroup } from './types';

export type ActiveFilters = Readonly<Record<string, string>>;

/** Each group's starting option: its `default`, else its first. */
export function defaultFilters(groups: readonly RecordFilterGroup[] | undefined): ActiveFilters {
    const out: Record<string, string> = {};
    for (const g of groups ?? []) {
        const first = g.options[0];
        if (first) out[g.id] = g.default ?? first.id;
    }
    return out;
}

/** Does a row pass every group's active option? */
export function passesFilters(groups: readonly RecordFilterGroup[] | undefined, active: ActiveFilters, rec: Rec, now: number): boolean {
    return (groups ?? []).every((g) => {
        const option = g.options.find((o) => o.id === active[g.id]);
        return option ? option.match(rec, now) : true;
    });
}

/** Rows per option of one group, counted against the full set. */
export function filterCounts(group: RecordFilterGroup, rows: readonly Rec[], now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of group.options) out[o.id] = rows.filter((r) => o.match(r, now)).length;
    return out;
}
