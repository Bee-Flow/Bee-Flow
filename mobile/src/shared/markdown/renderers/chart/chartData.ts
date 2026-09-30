/**
 * The data side of a chart: reading a field's values, inferring a missing
 * type, aggregating, and ordering categories the way Vega-Lite does (a
 * category axis sorts ascending unless the spec says otherwise; `sort: null`
 * keeps the data's order; `-y` orders by the measure, largest first).
 */

import { toTime } from './scales';
import type { Aggregate, FieldType, Row } from './vegaSpec';

/** A number from the data: a number, or a string that is one ("1,234" included). */
export function numeric(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

const DATE_LIKE = /^\d{4}(-\d{1,2}(-\d{1,2}([T ][\d:.]+Z?)?)?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/** A field's type when the spec leaves it out: numbers are quantitative, dates temporal, the rest nominal. */
export function inferType(rows: readonly Row[], field: string | null): FieldType {
    if (!field) return 'quantitative';
    const present = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined && v !== '');
    if (!present.length) return 'nominal';
    if (present.every((v) => typeof v === 'number' || numeric(v) !== null)) {
        return present.every((v) => typeof v === 'string' && DATE_LIKE.test(v)) ? 'temporal' : 'quantitative';
    }
    return present.every((v) => typeof v === 'string' && DATE_LIKE.test(v.trim()) && toTime(v) !== null)
        ? 'temporal'
        : 'nominal';
}

export function aggregateValues(values: readonly number[], op: Aggregate): number {
    if (!values.length) return 0;
    switch (op) {
        case 'count':
            return values.length;
        case 'mean':
            return values.reduce((s, v) => s + v, 0) / values.length;
        case 'min':
            return Math.min(...values);
        case 'max':
            return Math.max(...values);
        case 'median': {
            const sorted = [...values].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
        }
        default:
            return values.reduce((s, v) => s + v, 0);
    }
}

/** Compare two category keys in their field's natural order. */
function compareKeys(type: FieldType): (a: string, b: string) => number {
    if (type === 'temporal') return (a, b) => (toTime(a) ?? 0) - (toTime(b) ?? 0);
    if (type === 'quantitative') return (a, b) => (numeric(a) ?? 0) - (numeric(b) ?? 0);
    return (a, b) => a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Categories in the order a spec asks for. `totals` is each category's
 * measure, for sorting by the other axis (`-y`, `x`, …).
 */
export function orderCategories(
    keys: readonly string[],
    sort: string | string[] | null,
    type: FieldType,
    totals: ReadonlyMap<string, number>,
): string[] {
    if (sort === null) return [...keys];
    if (Array.isArray(sort)) {
        const known = sort.filter((k) => keys.includes(k));
        return [...known, ...keys.filter((k) => !known.includes(k))];
    }
    if (/^-?[xy]$/.test(sort)) {
        const dir = sort.startsWith('-') ? -1 : 1;
        return [...keys].sort((a, b) => dir * ((totals.get(a) ?? 0) - (totals.get(b) ?? 0)));
    }
    const sorted = [...keys].sort(compareKeys(type));
    return sort === 'descending' ? sorted.reverse() : sorted;
}

/** Distinct values, in first-seen order. */
export function distinct(values: readonly string[]): string[] {
    return [...new Set(values)];
}
