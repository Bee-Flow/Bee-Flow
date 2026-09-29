import { walkRelativePath as walkRelativePathJs } from '../../../../utils/bindingHelpers';

/**
 * Small, pure helpers the output views share: shape tests, scalar text,
 * readable labels and the dotted-path walk a table column resolves with.
 */

export const MAX_ROWS = 50;
/**
 * How many columns render before the "+N more columns" affordance.
 *
 * 12 was fine for a flat result row and useless the moment anything was
 * expanded: one drilled-into task object from a real API blows past it, and
 * the columns it dropped were exactly the ones the user opened the column to
 * see. Raised, and the cap is now a BUTTON that reveals the rest instead of a
 * dead label (BFSF-402).
 */
export const MAX_COLS = 24;
export const MAX_CELL = 80;
/**
 * How wide one table column may get, in px.
 *
 * Without a cap, a single column of full email addresses pushed every other
 * column off the right of the panel. Cells clamp to one line and the hover
 * card shows whatever didn't fit.
 */
export const COL_MAX_PX = 220;

export type PlainObject = Record<string, unknown>;

const walkRelativePath = walkRelativePathJs as (path: string, value: unknown) => unknown;

export function isPlainObject(v: unknown): v is PlainObject {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function scalarText(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
}

export function truncate(s: unknown, n: number = MAX_CELL): string {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/** camelCase / snake_case / kebab → "Title case" for readable headers/labels. */
export function humanize(key: unknown): string {
    return String(key)
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, (c) => c.toUpperCase());
}

export function safeJson(v: unknown): string {
    try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

export function prettyJson(v: unknown): string {
    try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

// Wildcard-aware: a `[*]` segment maps + flattens one level, byte-for-byte
// the runtime's semantics (walkRelativePath mirrors server bind.js). A naive
// dotted walk would render an expanded array column as a column of `—` while
// the paths it maps resolved fine.
export function getByDotted(obj: unknown, dotted: string): unknown {
    const v = walkRelativePath(dotted, obj);
    if (v !== undefined) return v;
    // Fallback for keys the strict path grammar rejects ('content-type'): the
    // historical naive walk. No [*] support here, but wildcarded columns only
    // ever come from the table's own splice, which uses real object keys.
    let cur: unknown = obj;
    for (const k of dotted.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as PlainObject)[k];
    }
    return cur;
}

// Resolve a cell's value for a (possibly dotted or wildcarded) column path.
export function cellValue(row: unknown, col: string, baseColCount: number): unknown {
    if (col.includes('.') || col.includes('[*]')) return getByDotted(row, col);
    return isPlainObject(row) ? row[col] : (baseColCount === 1 ? row : undefined);
}
