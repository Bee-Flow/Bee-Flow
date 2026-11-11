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
import { resolveAggSort, resolveAggOrderBy } from './queryCompilerOrder.mts';
import { scopeColumns, scopeRelated } from './columnRights.mts';
import {
    aggregateIsNumeric, countDistinctSql, extendedGroupBy, groupFilterSql, isExtendedGroupBy, newExtState,
    type ExtState, type RelatedTables,
} from './queryCompilerAggregateExt.mts';

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
    /** Joins, their parameters and the aggregate expressions of the vocabulary after v2. */
    ext: ExtState;
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
function addGroupBy(tableMeta: TableMeta, fm: FieldMap, entry: unknown, dialect: string, state: AggState, related?: RelatedTables): void {
    if (!entry || typeof entry !== 'object') throw new CompileError('groupBy entry must be an object');
    const g = entry as Entry;
    if (isExtendedGroupBy(g)) {
        const ext = extendedGroupBy(tableMeta, fm, g, dialect, related, state.ext);
        pushGroup(state, ext.expr, safeAlias(g.as || ext.alias));
        return;
    }
    const col = core.resolveColumn(tableMeta, g.field, fm);
    if (g.bucket && !DATE_BUCKETS.includes(g.bucket as string)) throw new CompileError(`unknown date bucket: ${g.bucket}`);
    const expr = g.bucket ? dateBucketSql(col, g.bucket, dialect) : col;
    if (expr === null) throw new CompileError(`unknown date bucket: ${g.bucket}`);
    const alias = safeAlias(g.as || (g.bucket ? `${g.field}_${g.bucket}` : g.field));
    pushGroup(state, expr, alias);
}

function pushGroup(state: AggState, expr: string, alias: string): void {
    state.selectParts.push(`${expr} AS ${qi(alias)}`);
    state.groupExprs.push(expr);
    state.groupAliases.push(alias);
    state.knownAliases.add(alias);
}

/** The outer expression of the i-th SQLite percentile (see percentileSql). */
function percentileOuterExpr(fraction: number, i: number): string {
    return `MIN(CASE WHEN ${qi(`__rn_${i}`)} >= CAST(${fraction} * ${qi(`__cn_${i}`)} + 0.5 AS INTEGER) THEN ${qi(`__pv_${i}`)} END)`;
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
    const numeric = aggregateIsNumeric(fn, fm, a.field);
    if (dialect === 'pg') {
        const expr = `PERCENTILE_DISC(${PERCENTILE_FNS[fn]}) WITHIN GROUP (ORDER BY ${pcol})`;
        state.selectParts.push(`${expr} AS ${qi(alias)}`);
        state.ext.aggExprs.set(alias, { expr, numeric });
    } else {
        state.ext.aggExprs.set(alias, { expr: percentileOuterExpr(PERCENTILE_FNS[fn], state.percentiles.length), numeric });
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
    let expr: string;
    if (fn === 'countDistinct') expr = countDistinctSql(tableMeta, fm, a.field);
    else {
        const inner = (fn === 'count' && isWholeRow(a.field)) ? '*' : core.resolveColumn(tableMeta, a.field, fm);
        expr = `${fn.toUpperCase()}(${inner})`;
    }
    state.selectParts.push(`${expr} AS ${qi(alias)}`);
    state.ext.aggExprs.set(alias, { expr, numeric: aggregateIsNumeric(fn, fm, a.field) });
    state.knownAliases.add(alias);
}

/** ORDER BY one output alias (`sort`) or up to three (`orderBy`, which wins), then the LIMIT, shared by both shapes. */
function finish(sql: string, opts: Entry, state: AggState, params: unknown[], limit: number): { sql: string; params: unknown[] } {
    let out = sql;
    const orderBy = resolveAggOrderBy(opts.orderBy, state.knownAliases) ?? resolveAggSort(opts.sort, state.knownAliases);
    if (orderBy) out += ` ORDER BY ${orderBy}`;
    out += ` LIMIT ?`;
    params.push(limit);
    return { sql: out, params };
}

/** The FROM target: the table, then any relation joins (none: exactly the table). */
function fromSql(tableKey: string, state: AggState): string {
    return [qi(tableKey), ...state.ext.joins].join(' ');
}

/** No percentile on SQLite (or any on pg): one SELECT … GROUP BY. */
function plainSql(tableKey: string, where: string, state: AggState): string {
    let sql = `SELECT ${state.selectParts.join(', ')} FROM ${fromSql(tableKey, state)} ${where}`;
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
        outerParts.push(`${percentileOuterExpr(p.fraction, i)} AS ${qi(p.alias)}`);
    });

    let sql = `WITH __src AS (SELECT ${srcParts.join(', ')} FROM ${fromSql(tableKey, state)} ${where})`
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
 *
 * `related` (optional) carries, per relation field, the table it points at and
 * the viewer's access predicate on it, for groupBy entries with relatedField
 * (queryCompilerAggregateExt.mts). Without it such an entry is refused.
 *
 * The table descriptor may be wider than the local type: scoping keeps whatever it carries.
 */
export function compileAggregate(table: TableMeta, opts: Entry = {}, accessFilter?: AccessFilter, relatedTables?: RelatedTables): { sql: string; params: unknown[] } {
    const dialect = resolveDialect(opts);
    core.assertTableMeta(table);
    // The table and the related tables as the viewer's role reads them (columnRights.mts): a
    // filter, a group, an aggregate or a groupFilter on a field hidden from that role is refused.
    const { tableMeta } = scopeColumns(table, accessFilter);
    const related = scopeRelated(relatedTables);
    const fm = core.fieldMap(tableMeta);
    const { where, params } = compileWhere({
        tableMeta, fm, filters: opts.filters, accessFilter: accessFilter as AccessFilter, dialect, match: opts.match, related,
    });
    const { groupBy, aggregates } = aggregateLists(opts);
    const state: AggState = { selectParts: [], groupExprs: [], groupAliases: [], knownAliases: new Set(), percentiles: [], ext: newExtState() };
    for (const g of groupBy) addGroupBy(tableMeta, fm, g, dialect, state, related);
    // Percentiles need a ranked window over the rows, so they take a different
    // shape (a CTE) from the plain aggregates. Detected first so the simple path
    // compiles byte-identically to before when none is requested.
    for (const a of aggregates) addAggregate(tableMeta, fm, a, dialect, state);
    const limit = core.clampLimit(opts.limit);
    const tableKey = tableMeta.key as string;
    const all = [...state.ext.joinParams, ...params];
    const sql = (state.percentiles.length === 0 ? plainSql(tableKey, where, state) : percentileSql(tableKey, where, state))
        + groupFilterSql(opts.groupFilter, state.ext, all);
    return finish(sql, opts, state, all, limit);
}
