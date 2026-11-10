/**
 * Grouped aggregate queries: group-by columns and date buckets, the aggregate
 * functions, and the percentile shape.
 *
 * The access predicate is ANDed into the WHERE BEFORE GROUP BY, so buckets fold
 * only visible rows (no cross-tenant/cross-owner aggregate leakage).
 *
 * Moved out of queryCompiler.js (compileAggregate) without a change to the SQL
 * it emits or to the order in which it refuses a bad descriptor
 * (queryCompiler.snapshot.test.js pins both). queryCompiler.js re-exports it.
 */

import { createRequire } from 'node:module';
import { compileWhere } from './queryCompilerFilter.mts';
import { resolveAggSort } from './queryCompilerOrder.mts';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; computed?: { stored?: boolean } };
type TableMeta = { key?: string; fields?: Field[] };
type FieldMap = Map<string, Field>;
type AccessFilter = { where: string; params: unknown[] };
type Entry = Record<string, unknown>;
type Percentile = { alias: string; fraction: number; col: string };

/** The parts of the select list as they are built, in the order they are built. */
type AggState = {
    selectParts: string[];
    groupExprs: string[];
    groupAliases: string[];
    knownAliases: Set<string>;
    percentiles: Percentile[];
};

const core = nodeRequire('./queryCompilerCore') as {
    MAX_GROUP_BY: number;
    MAX_AGGREGATES: number;
    ALIAS_RE: RegExp;
    CompileError: new (message: string) => Error;
    qi(name: string): string;
    assertTableMeta(tableMeta: TableMeta): void;
    fieldMap(tableMeta: TableMeta): FieldMap;
    resolveColumn(tableMeta: TableMeta, fieldName: unknown, fm?: FieldMap): string;
    clampLimit(limit: unknown, max?: number): number;
};
const { AGG_FNS, PERCENTILE_FNS, DATE_BUCKETS } = nodeRequire('./dataModel/vocabulary') as {
    AGG_FNS: readonly string[];
    PERCENTILE_FNS: Readonly<Record<string, number>>;
    DATE_BUCKETS: readonly string[];
};
const { resolveDialect } = nodeRequire('./engineFlag') as { resolveDialect(opts: unknown): string };
const { dateBucketSql } = nodeRequire('./dateBuckets') as { dateBucketSql(col: string, bucket: unknown, dialect: unknown): string | null };

const { CompileError, qi } = core;

function safeAlias(alias: unknown): string {
    if (typeof alias !== 'string' || !core.ALIAS_RE.test(alias)) throw new CompileError(`invalid alias: ${alias}`);
    return alias;
}

const isWholeRow = (field: unknown): boolean => field === undefined || field === null || field === '*';

/** The groupBy and aggregates lists, refused when too long or both empty. */
function aggregateLists(opts: Entry): { groupBy: unknown[]; aggregates: unknown[] } {
    const groupBy: unknown[] = Array.isArray(opts.groupBy) ? opts.groupBy : [];
    const aggregates: unknown[] = Array.isArray(opts.aggregates) ? opts.aggregates : [];
    if (groupBy.length > core.MAX_GROUP_BY) throw new CompileError(`too many groupBy fields (max ${core.MAX_GROUP_BY})`);
    if (aggregates.length > core.MAX_AGGREGATES) throw new CompileError(`too many aggregates (max ${core.MAX_AGGREGATES})`);
    if (groupBy.length === 0 && aggregates.length === 0) {
        throw new CompileError('aggregate query needs at least one groupBy or aggregate');
    }
    return { groupBy, aggregates };
}

/** One groupBy entry: a column, or a date bucket over one, under its alias. */
function addGroupBy(tableMeta: TableMeta, fm: FieldMap, entry: unknown, dialect: string, state: AggState): void {
    if (!entry || typeof entry !== 'object') throw new CompileError('groupBy entry must be an object');
    const g = entry as Entry;
    const col = core.resolveColumn(tableMeta, g.field, fm);
    if (g.bucket && !DATE_BUCKETS.includes(g.bucket as string)) throw new CompileError(`unknown date bucket: ${g.bucket}`);
    const expr = g.bucket ? dateBucketSql(col, g.bucket, dialect) : col;
    if (expr === null) throw new CompileError(`unknown date bucket: ${g.bucket}`);
    const alias = safeAlias(g.as || (g.bucket ? `${g.field}_${g.bucket}` : g.field));
    state.selectParts.push(`${expr} AS ${qi(alias)}`);
    state.groupExprs.push(expr);
    state.groupAliases.push(alias);
    state.knownAliases.add(alias);
}

/**
 * A p50/p90. Postgres HAS a discrete-percentile aggregate, so pg keeps the
 * plain single-query shape — the access filter stays in the one WHERE that
 * feeds the aggregate, same invariant as the CTE. The fraction comes from the
 * frozen PERCENTILE_FNS map (0.5 / 0.9), never from the client, so
 * interpolating it is safe. SQLite has none and gets the ranked CTE below.
 */
function addPercentile(tableMeta: TableMeta, fm: FieldMap, a: Entry, alias: string, dialect: string, state: AggState): void {
    const fn = a.fn as string;
    if (isWholeRow(a.field)) throw new CompileError(`${fn} needs a field to rank`);
    const pcol = core.resolveColumn(tableMeta, a.field, fm);
    if (dialect === 'pg') {
        state.selectParts.push(`PERCENTILE_DISC(${PERCENTILE_FNS[fn]}) WITHIN GROUP (ORDER BY ${pcol}) AS ${qi(alias)}`);
    } else {
        state.percentiles.push({ alias, fraction: PERCENTILE_FNS[fn], col: pcol });
    }
    state.knownAliases.add(alias);
}

/** One aggregates entry: the function is checked first, then the alias, then the column. */
function addAggregate(tableMeta: TableMeta, fm: FieldMap, entry: unknown, dialect: string, state: AggState): void {
    if (!entry || typeof entry !== 'object') throw new CompileError('aggregate entry must be an object');
    const a = entry as Entry;
    if (!AGG_FNS.includes(a.fn as string)) throw new CompileError(`unknown aggregate fn: ${a.fn}`);
    const fn = a.fn as string;
    const alias = safeAlias(a.as || `${fn}_${a.field && a.field !== '*' ? a.field : 'all'}`);
    if (PERCENTILE_FNS[fn] !== undefined) {
        addPercentile(tableMeta, fm, a, alias, dialect, state);
        return;
    }
    const inner = (fn === 'count' && isWholeRow(a.field)) ? '*' : core.resolveColumn(tableMeta, a.field, fm);
    state.selectParts.push(`${fn.toUpperCase()}(${inner}) AS ${qi(alias)}`);
    state.knownAliases.add(alias);
}

/** ORDER BY one output alias, then the LIMIT, shared by both shapes. */
function finish(sql: string, sort: unknown, state: AggState, params: unknown[], limit: number): { sql: string; params: unknown[] } {
    let out = sql;
    const orderBy = resolveAggSort(sort, state.knownAliases);
    if (orderBy) out += ` ORDER BY ${orderBy}`;
    out += ` LIMIT ?`;
    params.push(limit);
    return { sql: out, params };
}

/** No percentile on SQLite (or any on pg): one SELECT … GROUP BY. */
function plainSql(tableKey: string, where: string, state: AggState): string {
    let sql = `SELECT ${state.selectParts.join(', ')} FROM ${qi(tableKey)} ${where}`;
    if (state.groupExprs.length) sql += ` GROUP BY ${state.groupExprs.join(', ')}`;
    return sql;
}

/*
 * Nearest-rank percentile via a window function.
 *
 * The access predicate lives in the CTE's WHERE, NOT the outer query. That
 * placement is the whole security story here: the window ranks whatever the
 * CTE returns, so filtering afterwards would compute the median over rows
 * the viewer is not allowed to see and then hand them the answer. Assert on
 * it in tests, not just in review.
 *
 * ORDER BY puts NULLs last and COUNT(col) counts non-NULLs, so a column with
 * gaps ranks over its real values instead of over a pile of nulls.
 */
function percentileSql(tableKey: string, where: string, state: AggState): string {
    const { groupExprs, groupAliases } = state;
    const partition = groupExprs.length ? `PARTITION BY ${groupExprs.join(', ')} ` : '';
    const srcParts = [...groupExprs.map((expr, i) => `${expr} AS ${qi(groupAliases[i])}`)];
    const outerParts = [...groupAliases.map((alias) => qi(alias))];

    // The non-percentile aggregates still work — they just fold the CTE.
    for (const part of state.selectParts.slice(groupAliases.length)) outerParts.push(part);

    state.percentiles.forEach((p, i) => {
        const v = `__pv_${i}`;
        const rn = `__rn_${i}`;
        const cn = `__cn_${i}`;
        srcParts.push(`${p.col} AS ${qi(v)}`);
        srcParts.push(`ROW_NUMBER() OVER (${partition}ORDER BY (CASE WHEN ${p.col} IS NULL THEN 1 ELSE 0 END), ${p.col}) AS ${qi(rn)}`);
        srcParts.push(`COUNT(${p.col}) OVER (${partition}) AS ${qi(cn)}`);
        outerParts.push(
            `MIN(CASE WHEN ${qi(rn)} >= CAST(${p.fraction} * ${qi(cn)} + 0.5 AS INTEGER) THEN ${qi(v)} END) AS ${qi(p.alias)}`,
        );
    });

    let sql = `WITH __src AS (SELECT ${srcParts.join(', ')} FROM ${qi(tableKey)} ${where})`
        + ` SELECT ${outerParts.join(', ')} FROM __src`;
    if (groupAliases.length) sql += ` GROUP BY ${groupAliases.map((a) => qi(a)).join(', ')}`;
    return sql;
}

/**
 * Grouped aggregate query.
 *   compileAggregate(tableMeta, { filters, groupBy:[{field,bucket,as}],
 *     aggregates:[{fn,field,as}], sort, limit }, accessFilter)
 * The access predicate is ANDed into the WHERE BEFORE GROUP BY, so buckets fold
 * only visible rows (no cross-tenant/cross-owner aggregate leakage).
 */
export function compileAggregate(tableMeta: TableMeta, opts: Entry = {}, accessFilter?: AccessFilter): { sql: string; params: unknown[] } {
    const dialect = resolveDialect(opts);
    core.assertTableMeta(tableMeta);
    const fm = core.fieldMap(tableMeta);
    const { where, params } = compileWhere({
        tableMeta, fm, filters: opts.filters, accessFilter: accessFilter as AccessFilter, dialect, match: opts.match,
    });
    const { groupBy, aggregates } = aggregateLists(opts);
    const state: AggState = { selectParts: [], groupExprs: [], groupAliases: [], knownAliases: new Set(), percentiles: [] };
    for (const g of groupBy) addGroupBy(tableMeta, fm, g, dialect, state);
    // Percentiles need a ranked window over the rows, so they take a different
    // shape (a CTE) from the plain aggregates. Detected first so the simple path
    // compiles byte-identically to before when none is requested.
    for (const a of aggregates) addAggregate(tableMeta, fm, a, dialect, state);
    const limit = core.clampLimit(opts.limit);
    const tableKey = tableMeta.key as string;
    const sql = state.percentiles.length === 0 ? plainSql(tableKey, where, state) : percentileSql(tableKey, where, state);
    return finish(sql, opts.sort, state, [...params], limit);
}
