/**
 * Ordering and the keyset cursor of a read.
 *
 * A record list sorts on ONE column with `id` as the tiebreaker in the same
 * direction, so (column, id) is a total order and a row-value comparison is a
 * correct keyset predicate. An aggregate sorts on one of its own output
 * aliases. The cursor is an opaque base64url of (primary-sort-value, id) —
 * mirrors automationStore/runs.js.
 *
 * Moved out of queryCompiler.js without a change to the SQL it emits
 * (queryCompiler.snapshot.test.js pins it).
 *
 * `orderBy` is the multi-column sort: up to MAX_ORDER_BY columns, each with its
 * own direction, `id` as the last tiebreaker. A `sort` list keeps meaning its
 * first entry only, as it always has, so a stored descriptor reads the rows it
 * read before; `orderBy` is the key that asks for more. Its order is total and
 * the same on both engines: an empty (NULL) value sorts after every value in
 * either direction. Its keyset predicate is the expanded form (one OR branch
 * per column), because a row-value comparison is only correct when every
 * column runs in the same direction and none is NULL.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; computed?: { stored?: boolean } };
type TableMeta = { key?: string; fields?: Field[] };
type FieldMap = Map<string, Field>;

/** The primary sort column of a record list. */
export type PrimarySort = { fieldKey: string; column: string; dir: 'asc' | 'desc' };

const core = nodeRequire('./queryCompilerCore') as {
    CompileError: new (message: string) => Error;
    qi(name: string): string;
    resolveColumn(tableMeta: TableMeta, fieldName: unknown, fm?: FieldMap): string;
};
const { bestEffort } = nodeRequire('../../utils/bestEffort') as { bestEffort(tag: string, err: unknown): void };

/** Columns one `orderBy` may name. A limit on what a descriptor may say, so a constant. */
export const MAX_ORDER_BY = 3;

/** One column of an `orderBy`. */
export type OrderColumn = { fieldKey: string; column: string; dir: 'asc' | 'desc' };

/** A keyset cursor for (value, id); null when either is missing. */
export function encodeCursor(v: unknown, i: unknown): string | null {
    if (v === undefined || v === null || i === undefined || i === null) return null;
    return Buffer.from(JSON.stringify({ v, i }), 'utf8').toString('base64url');
}

/** A malformed cursor decodes to null (fall back to page 1) rather than 500. */
export function decodeCursor(cursor: unknown): { v: unknown; i: unknown } | null {
    if (!cursor || typeof cursor !== 'string') return null;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (o && o.v !== undefined && o.v !== null && o.i !== undefined && o.i !== null) {
            return { v: o.v, i: o.i };
        }
    } catch (err) { bestEffort('core/dataEngine/queryCompiler:decodeCursor', err); /* fall through */ }
    return null;
}

/** 'asc' for an entry that says so in either key, any case; everything else is 'desc'. */
function directionOf(entry: Record<string, unknown>): 'asc' | 'desc' {
    return String(entry.dir || entry.direction || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
}

/** The first entry of a sort list, or the sort object itself. */
function firstSortEntry(sort: unknown): Record<string, unknown> | null {
    const first: unknown = Array.isArray(sort) ? sort[0] : sort;
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).field === 'string'
        && (first as Record<string, unknown>).field) {
        return first as Record<string, unknown>;
    }
    return null;
}

// Single-column keyset sort: the first valid `sort` entry becomes the primary
// column (default created_at DESC); `id` is the tiebreaker in the same
// direction, making (col, id) a total order for a correct row-value keyset.
export function resolvePrimarySort(tableMeta: TableMeta, fm: FieldMap, sort: unknown): PrimarySort {
    const first = firstSortEntry(sort);
    if (first) {
        const column = core.resolveColumn(tableMeta, first.field, fm);
        return { fieldKey: first.field as string, column, dir: directionOf(first) };
    }
    return { fieldKey: 'created_at', column: core.qi('created_at'), dir: 'desc' };
}

/** The keyset predicate past `cursor` (already decoded), ANDed after the WHERE. */
export function keysetClause(primary: PrimarySort, cursor: { v: unknown; i: unknown }): { sql: string; params: unknown[] } {
    const cmp = primary.dir === 'asc' ? '>' : '<';
    return { sql: ` AND (${primary.column}, ${core.qi('id')}) ${cmp} (?, ?)`, params: [cursor.v, cursor.i] };
}

/** `ORDER BY <column> <DIR>, "id" <DIR>` for a record list. */
export function recordOrderBy(primary: PrimarySort): string {
    const DIR = primary.dir.toUpperCase();
    return `ORDER BY ${primary.column} ${DIR}, ${core.qi('id')} ${DIR}`;
}

/** The entries of an `orderBy`: one entry or a list of 1..MAX_ORDER_BY, each naming a field once. Null: none asked for. */
function orderEntries(orderBy: unknown): Record<string, unknown>[] | null {
    if (orderBy === undefined || orderBy === null) return null;
    const list: unknown[] = Array.isArray(orderBy) ? orderBy : [orderBy];
    if (list.length === 0) return null;
    if (list.length > MAX_ORDER_BY) throw new core.CompileError(`orderBy takes at most ${MAX_ORDER_BY} columns`);
    const seen = new Set<string>();
    return list.map((entry) => {
        const e = entry as Record<string, unknown> | null;
        if (!e || typeof e !== 'object' || typeof e.field !== 'string' || !e.field) {
            throw new core.CompileError('each orderBy entry needs a field');
        }
        if (seen.has(e.field)) throw new core.CompileError(`orderBy names "${e.field}" twice`);
        seen.add(e.field);
        return e;
    });
}

/**
 * The columns of a record list's `orderBy`, resolved through the model, with
 * `id` as the last one (added in the last column's direction when the author
 * did not name it; nothing after a unique column can change the order, so the
 * list ends there). Null: no orderBy, the legacy `sort` applies.
 */
export function resolveOrderBy(tableMeta: TableMeta, fm: FieldMap, orderBy: unknown): OrderColumn[] | null {
    const entries = orderEntries(orderBy);
    if (!entries) return null;
    const columns: OrderColumn[] = [];
    for (const e of entries) {
        columns.push({ fieldKey: e.field as string, column: core.resolveColumn(tableMeta, e.field, fm), dir: directionOf(e) });
    }
    const idAt = columns.findIndex((c) => c.fieldKey === 'id');
    if (idAt >= 0) return columns.slice(0, idAt + 1);
    return [...columns, { fieldKey: 'id', column: core.qi('id'), dir: columns[columns.length - 1].dir }];
}

/** `ORDER BY (a IS NULL), a DIR, …, "id" DIR`: empty values last per column. `id` is never empty. */
export function orderByClause(columns: OrderColumn[]): string {
    const parts = columns.map((c) => (c.fieldKey === 'id'
        ? `${c.column} ${c.dir.toUpperCase()}`
        : `(${c.column} IS NULL), ${c.column} ${c.dir.toUpperCase()}`));
    return `ORDER BY ${parts.join(', ')}`;
}

/** The cursor of the row a page ends on, for an `orderBy` read: every sort value in order (null included; the id is the last). */
export function encodeOrderCursor(columns: OrderColumn[], row: Record<string, unknown>): string | null {
    if (!row || row.id === undefined || row.id === null) return null;
    const values = columns.map((c) => (row[c.fieldKey] === undefined ? null : row[c.fieldKey]));
    return Buffer.from(JSON.stringify({ v: values, i: row.id }), 'utf8').toString('base64url');
}

/** "Sorts strictly after the cursor's value" on one column, empty values last. Null: nothing sorts after an empty value. */
function afterOnColumn(c: OrderColumn, value: unknown, params: unknown[]): string | null {
    if (value === null) return null;
    params.push(value);
    const cmp = c.dir === 'asc' ? '>' : '<';
    return c.fieldKey === 'id' ? `${c.column} ${cmp} ?` : `(${c.column} ${cmp} ? OR ${c.column} IS NULL)`;
}

/** "Has the cursor's value" on one column. */
function sameOnColumn(c: OrderColumn, value: unknown, params: unknown[]): string {
    if (value === null) return `${c.column} IS NULL`;
    params.push(value);
    return `${c.column} = ?`;
}

const isCursorScalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * The keyset predicate of an `orderBy` read, expanded: a row comes after the
 * cursor when it sorts after it on the first column, or equals it there and
 * sorts after it on the second, and so on down to `id`. A cursor that was not
 * minted for these columns is refused, never read as "page one" (which would
 * hand the same page back for ever).
 */
export function orderKeysetClause(columns: OrderColumn[], cursor: { v: unknown; i: unknown }): { sql: string; params: unknown[] } {
    const values = cursor.v;
    if (!Array.isArray(values) || values.length !== columns.length || !values.every(isCursorScalar) || values[values.length - 1] === null) {
        throw new core.CompileError('cursor does not belong to this orderBy');
    }
    const branches: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < columns.length; i += 1) {
        const branchParams: unknown[] = [];
        const same = columns.slice(0, i).map((c, j) => sameOnColumn(c, values[j], branchParams));
        const after = afterOnColumn(columns[i], values[i], branchParams);
        if (after === null) continue;
        branches.push(`(${[...same, after].join(' AND ')})`);
        params.push(...branchParams);
    }
    return { sql: ` AND (${branches.join(' OR ')})`, params };
}

/** An aggregate's `orderBy`: up to MAX_ORDER_BY of its own output columns. Null: none asked for, the legacy `sort` applies. */
export function resolveAggOrderBy(orderBy: unknown, knownAliases: Set<string>): string | null {
    const entries = orderEntries(orderBy);
    if (!entries) return null;
    return entries.map((e) => {
        const field = e.field as string;
        if (!knownAliases.has(field)) throw new core.CompileError(`cannot sort by unknown output column: ${field}`);
        return `${core.qi(field)} ${directionOf(e).toUpperCase()}`;
    }).join(', ');
}

/** An aggregate sorts on one of its own output columns; an unknown alias throws. Null: no sort asked for. */
export function resolveAggSort(sort: unknown, knownAliases: Set<string>): string | null {
    const first = firstSortEntry(sort);
    if (!first) return null;
    const field = first.field as string;
    if (!knownAliases.has(field)) throw new core.CompileError(`cannot sort by unknown output column: ${field}`);
    return `${core.qi(field)} ${directionOf(first).toUpperCase()}`;
}
