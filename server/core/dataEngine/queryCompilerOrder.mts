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

/** An aggregate sorts on one of its own output columns; an unknown alias throws. Null: no sort asked for. */
export function resolveAggSort(sort: unknown, knownAliases: Set<string>): string | null {
    const first = firstSortEntry(sort);
    if (!first) return null;
    const field = first.field as string;
    if (!knownAliases.has(field)) throw new core.CompileError(`cannot sort by unknown output column: ${field}`);
    return `${core.qi(field)} ${directionOf(first).toUpperCase()}`;
}
