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

export const FILTER_KIND = Object.freeze({
    text: 'text', number: 'number', date: 'date', boolean: 'boolean', select: 'select',
});

// More distinct values than this and a dropdown is a worse control than a box.
export const FACET_LIMIT = 40;

const NUMBER_FORMATS = new Set(['number', 'currency', 'percent', 'progress']);
const DATE_FORMATS = new Set(['date', 'datetime', 'relative']);
const BOOLEAN_FORMATS = new Set(['boolean', 'check']);
// Formats whose values are drawn from a small vocabulary — worth offering as a
// pick list when the data (or a toneMap) names that vocabulary.
const FACET_FORMATS = new Set(['badge', 'tags', 'relation']);

/** Which control (and matcher) a column of this format gets. */
export function filterKindFor(format: string | null | undefined, { hasOptions = false }: { hasOptions?: boolean } = {}): string {
    const f = format || 'text';
    if (NUMBER_FORMATS.has(f)) return FILTER_KIND.number;
    if (DATE_FORMATS.has(f)) return FILTER_KIND.date;
    if (BOOLEAN_FORMATS.has(f)) return FILTER_KIND.boolean;
    if (hasOptions && FACET_FORMATS.has(f)) return FILTER_KIND.select;
    return FILTER_KIND.text;
}

/** Whether a column of this format may offer its distinct values as a pick list. */
export function canFacet(format: string | null | undefined): boolean {
    return FACET_FORMATS.has(format || 'text');
}

/** The label-bearing shape a select cell may hold: a tag, a relation, a badge. */
interface LabelledCell {
    label?: unknown;
    name?: unknown;
    id?: unknown;
}

/** One pick-list option. */
export interface FacetOption {
    value: string;
    label: string;
}

/**
 * The distinct values of one column, as { value, label } options — or null
 * when there are none or too many to be a dropdown. A `tags` cell holds an
 * array; every tag counts on its own.
 */
export function facetValues(rows: Record<string, unknown>[] | null | undefined, key: string, limit = FACET_LIMIT): FacetOption[] | null {
    const seen = new Map<string, string>();
    for (const row of rows || []) {
        const raw = row?.[key];
        const items: unknown[] = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
            if (item == null || item === '') continue;
            const value = typeof item === 'object' ? ((item as LabelledCell).label ?? (item as LabelledCell).name ?? (item as LabelledCell).id ?? '') : item;
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
export function isActiveFilter(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === 'string') return value !== '';
    if (typeof value === 'object') return Object.values(value).some((v) => v != null && v !== '');
    return true;
}

/** A number range's ends, or a date range's. Each end may be blank. */
interface RangeFilter {
    min?: unknown;
    max?: unknown;
    from?: unknown;
    to?: unknown;
}

const toNumber = (v: unknown): number | null => {
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

const toTime = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
};

// The end of a from–to range is inclusive: "to 19 Sep" means the whole day.
const endOfDay = (t: number): number => {
    const d = new Date(t);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
};

const TRUE_WORDS = new Set(['true', '1', 'yes', 'ja', 'y', 'on', 'x', '✓']);
const toBool = (v: unknown): boolean | null => {
    if (v == null || v === '') return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return TRUE_WORDS.has(String(v).trim().toLowerCase());
};

const cellText = (v: unknown): string => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(cellText).join(' ');
    if (typeof v === 'object') {
        const cell = v as LabelledCell & { title?: unknown };
        return String(cell.label ?? cell.name ?? cell.title ?? cell.id ?? '');
    }
    return String(v);
};

/** A matcher takes the cell's value and the filter value it is tested against. */
type Matcher = (cell: unknown, filter: unknown) => boolean;

const MATCHERS: Record<string, Matcher> = {
    [FILTER_KIND.text]: (cell, q) => cellText(cell).toLowerCase().includes(String(q).toLowerCase()),
    [FILTER_KIND.number]: (cell, filter) => {
        const range = filter as RangeFilter | undefined;
        const n = toNumber(cell);
        const min = toNumber(range?.min); const max = toNumber(range?.max);
        // A blank cell never sits inside a range someone typed.
        if (n == null) return false;
        if (min != null && n < min) return false;
        if (max != null && n > max) return false;
        return true;
    },
    [FILTER_KIND.date]: (cell, filter) => {
        const range = filter as RangeFilter | undefined;
        const t = toTime(cell);
        const from = toTime(range?.from); const to = toTime(range?.to);
        if (t == null) return false;
        if (from != null && t < from) return false;
        if (to != null && t > endOfDay(to)) return false;
        return true;
    },
    [FILTER_KIND.boolean]: (cell, want) => {
        const b = toBool(cell);
        return want === 'true' ? b === true : b !== true;
    },
    [FILTER_KIND.select]: (cell, pick) => {
        const items: unknown[] = Array.isArray(cell) ? cell : [cell];
        return items.some((item) => cellText(item) === String(pick));
    },
};

/**
 * A TanStack filterFn for this kind. `autoRemove` is what lets a half-cleared
 * range drop out of the filter list instead of matching nothing forever.
 */
export function makeFilterFn(kind: string) {
    const match = MATCHERS[kind] || MATCHERS[FILTER_KIND.text];
    const fn = (row: { getValue: (columnId: string) => unknown }, columnId: string, filterValue: unknown): boolean => {
        if (!isActiveFilter(filterValue)) return true;
        return match(row.getValue(columnId), filterValue);
    };
    fn.autoRemove = (value: unknown) => !isActiveFilter(value);
    return fn;
}

/** The caller's translate function, or the English fallback with its {name} params filled in. */
type DescribeTranslate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/**
 * The chip text for an active filter: what is narrowed and to what, in the
 * reader's words — "Amount 500 – 2,000", "Date from 1 Sep", "Paid: yes".
 */
export function describeFilter(
    kind: string,
    value: unknown,
    { options = null, locale = undefined, t = null }: {
        options?: FacetOption[] | null;
        locale?: string;
        t?: DescribeTranslate | null;
    } = {},
): string {
    if (!isActiveFilter(value)) return '';
    // `t` is the caller's translate function; without one the English default is used.
    const tx: DescribeTranslate = t || ((_key: string, fallback: string, params?: Record<string, unknown>) => fallback.replace(/\{(\w+)\}/g, (_m: string, name: string) => String(params?.[name] ?? '')));
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
