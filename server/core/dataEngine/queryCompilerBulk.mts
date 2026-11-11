/**
 * Bulk record writes: the filter-scoped siblings of compileUpdate / compileDelete.
 *
 * App Studio's update_record / delete_record can address "every row matching this filter, up to
 * a limit" instead of one id (package 5), and writeTo.replaceWhere deletes a filtered set before
 * it writes. Every statement here is built the same way the reads are: `buildWhere` puts the
 * ACCESS predicate first and ANDs the author's clauses after it, so a filter can only narrow the
 * rows the viewer may write, never widen them. Each value is a bound parameter; each column goes
 * through the closed resolver.
 *
 * Two forms:
 *   - match then write (top level): `compileMatchIds` picks the ids (oldest first, limited), then
 *     `compileDeleteIds` / `compileUpdateIds` write exactly those ids WITH the access predicate and
 *     the filters re-applied, so a row that changed between the two statements is left alone.
 *   - one statement (inside a transaction, PLAN decision 12): `compileDeleteMatching` /
 *     `compileUpdateMatching` use a limited subquery, so the statement sees rows written earlier
 *     in the same batch.
 *
 * The ordering is `created_at ASC, id ASC`: an over-limit write changes the oldest rows, and the
 * same filter run again continues where the last one stopped.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type TableMeta = { key?: string; fields?: Obj[]; rowsLocked?: boolean };
type AccessFilter = { where: string; params: unknown[] };
type Filter = { field?: string; op?: string; value?: unknown; ci?: boolean };
type Compiled = { sql: string; params: unknown[] };
type Opts = { dialect?: string; limit?: unknown; allowLockedRows?: boolean };

const base = nodeRequire('./queryCompilerBase') as {
    CompileError: new (msg: string) => Error;
    qi(name: unknown): string;
    assertTableMeta(t: TableMeta): void;
    assertRowsWritable(t: TableMeta, o?: Obj): void;
    assertAccessFilter(f: AccessFilter): void;
    fieldMap(t: TableMeta): Map<string, Obj>;
    buildWhere(t: TableMeta, fm: Map<string, Obj>, filters: Filter[] | null, access: AccessFilter, dialect: string, match?: string): { where: string; params: unknown[] };
};
const { resolveDialect } = nodeRequire('./engineFlag') as { resolveDialect(o: Obj): string };
const { compileSetClause } = nodeRequire('./queryCompilerWrite') as {
    compileSetClause(t: TableMeta, values: unknown, dialect: string): { sets: string[]; params: unknown[] };
};
const { scopeColumns } = nodeRequire('./columnRights.mts') as {
    scopeColumns<T extends TableMeta>(t: T, access: unknown): { tableMeta: T };
};

/** The most rows one bulk statement may change. App Studio's LIMITS.MAX_BULK_WRITE_ROWS is the same number. */
export const MAX_BULK_ROWS = 500;

const ORDER = 'ORDER BY "created_at" ASC, "id" ASC';

/** A limit in 1..MAX_BULK_ROWS; anything else (absent, 0, garbage) is the maximum. */
export function clampBulkLimit(limit: unknown): number {
    const n = Number.parseInt(String(limit), 10);
    if (!Number.isFinite(n) || n <= 0) return MAX_BULK_ROWS;
    return Math.min(n, MAX_BULK_ROWS);
}

function whereOf(tableMeta: TableMeta, filters: Filter[], access: AccessFilter, opts: Opts): { dialect: string; where: string; params: unknown[] } {
    const dialect = resolveDialect({ dialect: opts.dialect });
    base.assertTableMeta(tableMeta);
    base.assertAccessFilter(access);
    if (!Array.isArray(filters)) throw new base.CompileError('a bulk write needs a filter list');
    // Which rows a bulk write matches is a read: the filter sees the table as the viewer's role
    // reads it (columnRights.mts), so a count of matches tells nothing about a hidden field.
    const visible = scopeColumns(tableMeta, access).tableMeta;
    const fm = base.fieldMap(visible);
    const { where, params } = base.buildWhere(visible, fm, filters, access, dialect, 'all');
    return { dialect, where, params };
}

function idList(ids: unknown): string[] {
    if (!Array.isArray(ids) || !ids.length) throw new base.CompileError('a bulk write needs at least one record id');
    if (ids.length > MAX_BULK_ROWS) throw new base.CompileError(`a bulk write changes at most ${MAX_BULK_ROWS} rows`);
    for (const id of ids) if (typeof id !== 'string' || !id) throw new base.CompileError('record ids must be non-empty strings');
    return ids as string[];
}

/** SELECT COUNT(*) AS n of the rows the viewer may write that match the filters. */
export function compileCountMatching(tableMeta: TableMeta, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled {
    const { where, params } = whereOf(tableMeta, filters, access, opts);
    return { sql: `SELECT COUNT(*) AS n FROM ${base.qi(tableMeta.key)} ${where}`, params };
}

/** SELECT id of the first `limit` matching rows (oldest first). */
export function compileMatchIds(tableMeta: TableMeta, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled & { limit: number } {
    const { where, params } = whereOf(tableMeta, filters, access, opts);
    const limit = clampBulkLimit(opts.limit);
    return { sql: `SELECT ${base.qi('id')} FROM ${base.qi(tableMeta.key)} ${where} ${ORDER} LIMIT ?`, params: [...params, limit], limit };
}

/** DELETE exactly these ids, with the access predicate and the filters re-applied. */
export function compileDeleteIds(tableMeta: TableMeta, ids: unknown, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled {
    base.assertTableMeta(tableMeta);
    base.assertRowsWritable(tableMeta, { allowLockedRows: opts.allowLockedRows === true });
    const list = idList(ids);
    const { where, params } = whereOf(tableMeta, filters, access, opts);
    return {
        sql: `DELETE FROM ${base.qi(tableMeta.key)} ${where} AND ${base.qi('id')} IN (${list.map(() => '?').join(', ')})`,
        params: [...params, ...list],
    };
}

/** UPDATE exactly these ids with `values`, with the access predicate and the filters re-applied. */
export function compileUpdateIds(tableMeta: TableMeta, ids: unknown, values: unknown, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled {
    base.assertTableMeta(tableMeta);
    base.assertRowsWritable(tableMeta, { allowLockedRows: opts.allowLockedRows === true });
    const list = idList(ids);
    const { dialect, where, params } = whereOf(tableMeta, filters, access, opts);
    const set = compileSetClause(tableMeta, values, dialect);
    return {
        sql: `UPDATE ${base.qi(tableMeta.key)} SET ${set.sets.join(', ')} ${where} AND ${base.qi('id')} IN (${list.map(() => '?').join(', ')})`,
        params: [...set.params, ...params, ...list],
    };
}

/** The limited subquery both one-statement forms share. */
function limitedSubquery(tableMeta: TableMeta, filters: Filter[], access: AccessFilter, opts: Opts): { dialect: string; where: string; params: unknown[]; sub: string; subParams: unknown[] } {
    const { dialect, where, params } = whereOf(tableMeta, filters, access, opts);
    const limit = clampBulkLimit(opts.limit);
    const sub = `SELECT ${base.qi('id')} FROM ${base.qi(tableMeta.key)} ${where} ${ORDER} LIMIT ?`;
    return { dialect, where, params, sub, subParams: [...params, limit] };
}

/** ONE statement: delete the first `limit` matching rows (for a transaction batch). */
export function compileDeleteMatching(tableMeta: TableMeta, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled {
    base.assertTableMeta(tableMeta);
    base.assertRowsWritable(tableMeta, { allowLockedRows: opts.allowLockedRows === true });
    const q = limitedSubquery(tableMeta, filters, access, opts);
    return {
        sql: `DELETE FROM ${base.qi(tableMeta.key)} ${q.where} AND ${base.qi('id')} IN (${q.sub})`,
        params: [...q.params, ...q.subParams],
    };
}

/** ONE statement: update the first `limit` matching rows (for a transaction batch). */
export function compileUpdateMatching(tableMeta: TableMeta, values: unknown, filters: Filter[], access: AccessFilter, opts: Opts = {}): Compiled {
    base.assertTableMeta(tableMeta);
    base.assertRowsWritable(tableMeta, { allowLockedRows: opts.allowLockedRows === true });
    const q = limitedSubquery(tableMeta, filters, access, opts);
    const set = compileSetClause(tableMeta, values, q.dialect);
    return {
        sql: `UPDATE ${base.qi(tableMeta.key)} SET ${set.sets.join(', ')} ${q.where} AND ${base.qi('id')} IN (${q.sub})`,
        params: [...set.params, ...q.params, ...q.subParams],
    };
}
