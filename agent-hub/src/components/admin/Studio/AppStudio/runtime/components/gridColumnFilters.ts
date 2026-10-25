/**
 * App Studio runtime — the per-column filters of a data_grid, typed by column.
 *
 * One substring box under every filterable heading was the whole story: a
 * number column filtered on "20" matched 120 and 2000, a date column matched
 * nothing anyone typed, and a status column with four known values still asked
 * you to spell one. The column's `format` already says what the values ARE, so
 * it can also say how to narrow them:
 *
 *   number · currency · percent · progress   → a min–max range
 *   date · datetime · relative               → a from–to range
 *   boolean · check                          → yes / no
 *   badge · tags · relation (known values)   → pick one
 *   everything else                          → contains
 *
 * Pure functions only: the controls live in AppDataGrid, the matching lives
 * here where it can be tested without a table around it.
 */

/**
 * @typedef {'text' | 'number' | 'date' | 'boolean' | 'select'} FilterKind
 * @typedef {{ min?: unknown, max?: unknown }} NumberRange A number filter value; either end may be empty.
 * @typedef {{ from?: unknown, to?: unknown }} DateRange A date filter value; either end may be empty.
 * @typedef {{ value: string, label: string }} FacetOption
 * @typedef {((row: { getValue: (columnId: string) => unknown }, columnId: string, filterValue: unknown) => boolean) & { autoRemove: (value: unknown) => boolean }} GridFilterFn
 */

import type { TranslateFn, TranslateParams } from '../../../../../../hooks/useTranslation';

/** A number or date filter value: either end may be empty. */
interface RangeFilter {
    min?: unknown;
    max?: unknown;
    from?: unknown;
    to?: unknown;
}

/** What a cell can hold: text, a number, a flag, an option object or a list of those. */
type CellItem = string | number | boolean | CellObject | CellItem[] | null | undefined;

interface CellObject {
    label?: unknown;
    name?: unknown;
    title?: unknown;
    id?: unknown;
}

export const FILTER_KIND = Object.freeze({
    text: 'text', number: 'number', date: 'date', boolean: 'boolean', select: 'select',
});

// More distinct values than this and a dropdown is a worse control than a box.
const FACET_LIMIT = 40;

const NUMBER_FORMATS = new Set(['number', 'currency', 'percent', 'progress']);
const DATE_FORMATS = new Set(['date', 'datetime', 'relative']);
const BOOLEAN_FORMATS = new Set(['boolean', 'check']);
// Formats whose values are drawn from a small vocabulary — worth offering as a
// pick list when the data (or a toneMap) names that vocabulary.
const FACET_FORMATS = new Set(['badge', 'tags', 'relation']);

/** Which control (and matcher) a column of this format gets. */
/**
 * @param {string | null} [format] A column format; empty means 'text'.
 * @param {{ hasOptions?: boolean }} [opts]
 * @returns {FilterKind}
 */
export function filterKindFor(format: string, { hasOptions = false } = {}) {
    const f = format || 'text';
    if (NUMBER_FORMATS.has(f)) return FILTER_KIND.number;
    if (DATE_FORMATS.has(f)) return FILTER_KIND.date;
    if (BOOLEAN_FORMATS.has(f)) return FILTER_KIND.boolean;
    if (hasOptions && FACET_FORMATS.has(f)) return FILTER_KIND.select;
    return FILTER_KIND.text;
}

/** Whether a column of this format may offer its distinct values as a pick list. */
/**
 * @param {string | null} [format]
 * @returns {boolean}
 */
export function canFacet(format: string) {
    return FACET_FORMATS.has(format || 'text');
}

/**
 * The distinct values of one column, as { value, label } options — or null
 * when there are none or too many to be a dropdown. A `tags` cell holds an
 * array; every tag counts on its own.
 */
/**
 * @param {ReadonlyArray<Record<string, unknown> | null | undefined> | null | undefined} rows
 * @param {string} key The column key read from each row.
 * @param {number} [limit] Defaults to FACET_LIMIT.
 * @returns {FacetOption[] | null}
 */
export function facetValues(rows: ReadonlyArray<Record<string, unknown> | null | undefined> | null | undefined, key: string, limit: number = FACET_LIMIT) {
    const seen = new Map<string, string>();
    for (const row of rows || []) {
        const raw = row?.[key];
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
            if (item == null || item === '') continue;
            const value = typeof item === 'object' ? (item.label ?? item.name ?? item.id ?? '') : item;
            const s = String(value);
            if (!s) continue;
            if (!seen.has(s)) seen.set(s, s);
            if (seen.size > limit) return null;
        }
    }
    if (seen.size === 0) return null;
    return Array.from(seen.keys())
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map((v) => ({ value: v, label: v }));
}

/** True when a filter value narrows anything (a range with both ends empty does not). */
/**
 * @param {unknown} value A filter value of any kind (string, range object, or empty).
 * @returns {boolean}
 */
export function isActiveFilter(value: unknown) {
    if (value == null) return false;
    if (typeof value === 'string') return value !== '';
    if (typeof value === 'object') return Object.values(value).some((v) => v != null && v !== '');
    return true;
}

const toNumber = (v: unknown) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    // "€1.234,50" and "1,234.50" both have to read as a number: strip the
    // currency, then whichever separator comes last is the decimal point.
    const s = String(v).replace(/[^\d.,-]/g, '');
    if (!s) return null;
    const lastComma = s.lastIndexOf(','); const lastDot = s.lastIndexOf('.');
    const normalised = lastComma > lastDot
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
    const n = Number(normalised);
    return Number.isFinite(n) ? n : null;
};

const toTime = (v: unknown) => {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
};

// The end of a from–to range is inclusive: "to 19 Sep" means the whole day.
const endOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
};

const TRUE_WORDS = new Set(['true', '1', 'yes', 'ja', 'y', 'on', 'x', '✓']);
const toBool = (v: unknown) => {
    if (v == null || v === '') return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return TRUE_WORDS.has(String(v).trim().toLowerCase());
};

const cellText = (v: CellItem): string => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(cellText).join(' ');
    if (typeof v === 'object') return String(v.label ?? v.name ?? v.title ?? v.id ?? '');
    return String(v);
};

/** A method type, so each matcher keeps its own argument type and the table can still be indexed by kind. */
type Matcher = {
    bivarianceHack(cell: unknown, arg: unknown): boolean;
}['bivarianceHack'];

const MATCHERS: Record<string, Matcher> = {
    [FILTER_KIND.text]: (cell: CellItem, q: unknown) => cellText(cell).toLowerCase().includes(String(q).toLowerCase()),
    [FILTER_KIND.number]: (cell: unknown, range: RangeFilter | undefined) => {
        const n = toNumber(cell);
        const min = toNumber(range?.min); const max = toNumber(range?.max);
        // A blank cell never sits inside a range someone typed.
        if (n == null) return false;
        if (min != null && n < min) return false;
        if (max != null && n > max) return false;
        return true;
    },
    [FILTER_KIND.date]: (cell: unknown, range: RangeFilter | undefined) => {
        const t = toTime(cell);
        const from = toTime(range?.from); const to = toTime(range?.to);
        if (t == null) return false;
        if (from != null && t < from) return false;
        if (to != null && t > endOfDay(to)) return false;
        return true;
    },
    [FILTER_KIND.boolean]: (cell: unknown, want: string) => {
        const b = toBool(cell);
        return want === 'true' ? b === true : b !== true;
    },
    [FILTER_KIND.select]: (cell: CellItem, pick: unknown) => {
        const items = Array.isArray(cell) ? cell : [cell];
        return items.some((item) => cellText(item) === String(pick));
    },
};

/**
 * A TanStack filterFn for this kind. `autoRemove` is what lets a half-cleared
 * range drop out of the filter list instead of matching nothing forever.
 */
/**
 * @param {string} [kind] A FilterKind; anything else gets the 'text' matcher.
 * @returns {GridFilterFn}
 */
export function makeFilterFn(kind: string) {
    const match = MATCHERS[kind] || MATCHERS[FILTER_KIND.text];
    const fn = (row: { getValue: (columnId: string) => unknown }, columnId: string, filterValue: unknown) => {
        if (!isActiveFilter(filterValue)) return true;
        return match(row.getValue(columnId), filterValue);
    };
    fn.autoRemove = (value: unknown) => !isActiveFilter(value);
    return fn;
}

/**
 * The chip text for an active filter: what is narrowed and to what, in the
 * reader's words — "Amount 500 – 2,000", "Date from 1 Sep", "Paid: yes".
 */
/**
 * @param {string | null | undefined} kind A FilterKind. Decides the shape `value` must have; anything else is quoted as text.
 * @param {string | NumberRange | DateRange | null | undefined} value 'number' takes a NumberRange, 'date' a DateRange,
 *   'boolean' the string 'true' or 'false', 'select' and 'text' a string.
 * @param {{ options?: ReadonlyArray<{ value: unknown, label?: string | null }> | null, locale?: string, t?: import('../../../../../../hooks/useTranslation').TranslateFn | null }} [opts]
 *   A 'select' chip shows the matching option's `label` as is, so it must be text.
 * @returns {string} Empty when the filter is not active.
 */
export function describeFilter(kind: string, value: string | RangeFilter | null | undefined, { options = null, locale = undefined, t = null }: { options?: ReadonlyArray<{ value: unknown; label?: string | null }> | null; locale?: string; t?: TranslateFn | null } = {}) {
    if (!isActiveFilter(value)) return '';
    // `t` is the caller's translate function; without one the English default is used.
    const tx = t || ((_key: string | undefined, fallback?: string | TranslateParams, params?: TranslateParams) => (fallback as string).replace(/\{(\w+)\}/g, (_m: string, name: string) => String(params?.[name] ?? '')));
    const num = (v: unknown) => {
        const n = toNumber(v);
        return n == null ? String(v) : n.toLocaleString(locale);
    };
    const day = (v: unknown) => {
        const t = toTime(v);
        return t == null ? String(v) : new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    };
    switch (kind) {
    case FILTER_KIND.number: {
        const { min, max } = value as RangeFilter;
        if (min !== '' && min != null && max !== '' && max != null) return `${num(min)} – ${num(max)}`;
        if (min !== '' && min != null) return `≥ ${num(min)}`;
        return `≤ ${num(max)}`;
    }
    case FILTER_KIND.date: {
        const { from, to } = value as RangeFilter;
        if (from && to) return `${day(from)} – ${day(to)}`;
        if (from) return tx('studio_apps_runtime.grid.filter_from', 'from {date}', { date: day(from) });
        return tx('studio_apps_runtime.grid.filter_until', 'until {date}', { date: day(to) });
    }
    case FILTER_KIND.boolean:
        return value === 'true' ? tx('studio_apps_runtime.grid.filter_yes', 'yes') : tx('studio_apps_runtime.grid.filter_no', 'no');
    case FILTER_KIND.select: {
        const hit = (options || []).find((o) => String(o.value) === String(value));
        return hit?.label ?? String(value);
    }
    default:
        return `“${value}”`;
    }
}
