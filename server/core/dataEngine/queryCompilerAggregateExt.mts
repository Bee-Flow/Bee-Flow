/**
 * The aggregate vocabulary after App Studio schema version 2: countDistinct,
 * numeric bins, group by a column of a related row, and a filter on the
 * aggregated groups (`groupFilter`, SQL HAVING). See AGG_FNS_EXTENDED in
 * dataModel/vocabulary.js.
 *
 * Every part is reached only when the descriptor uses it, so a descriptor
 * without them compiles through queryCompilerAggregate.mts exactly as before.
 *
 * GROUP BY A RELATED COLUMN. The related table is read through a derived table
 * that carries that table's OWN access predicate, LEFT JOINed on its id:
 *
 *   LEFT JOIN (SELECT "id" AS "__rid", <col> AS "__rv" FROM "<target>"
 *              WHERE (<target access>)) AS "__rel_0"
 *          ON "__rel_0"."__rid" = "<table>"."<fk>"
 *
 * A row whose related record the viewer may not read keeps counting (the row
 * itself is visible) but lands in the empty group: the related value never
 * leaves the derived table. The join is on the primary key, so it never
 * multiplies rows. The derived table exposes only `__rid` and `__rv`, names a
 * field key can never take (KEY_RE starts with a letter), so the unqualified
 * columns of the main WHERE stay unambiguous. The caller resolves the target
 * table and compiles its access filter (appStudio/aggregateRelated.mts); a
 * relation the caller did not hand over is refused, never read unscoped.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; relation?: { table?: string }; computed?: { stored?: boolean; type?: string } };
type TableMeta = { id?: string; key?: string; fields?: Field[] };
type FieldMap = Map<string, Field>;
type AccessFilter = { where: string; params: unknown[] };
type Entry = Record<string, unknown>;

/** The table a relation field points at, with the viewer's access predicate on it. */
export type RelatedTable = { tableMeta: TableMeta; accessFilter: AccessFilter };
/** Keyed by the relation field's key on the aggregated table. */
export type RelatedTables = Record<string, RelatedTable>;

/** What the extended vocabulary adds to the state of one compile. */
export type ExtState = {
    joins: string[];
    joinParams: unknown[];
    /** Aggregate alias → its SQL expression and whether it yields a number (for groupFilter). */
    aggExprs: Map<string, { expr: string; numeric: boolean }>;
};

const core = nodeRequire('./queryCompilerCore') as {
    CompileError: new (message: string) => Error;
    qi(name: string): string;
    assertTableMeta(tableMeta: TableMeta): void;
    assertAccessFilter(accessFilter: unknown): void;
    fieldMap(tableMeta: TableMeta): FieldMap;
    resolveColumn(tableMeta: TableMeta, fieldName: unknown, fm?: FieldMap): string;
};
const { DATE_BUCKETS, GROUP_FILTER_OPS, AGGREGATE_LIMITS } = nodeRequire('./dataModel/vocabulary') as {
    DATE_BUCKETS: readonly string[];
    GROUP_FILTER_OPS: readonly string[];
    AGGREGATE_LIMITS: { MAX_GROUP_FILTERS: number; MAX_RELATED_GROUP_BY: number; MAX_BIN_WIDTH: number };
};
const { dateBucketSql } = nodeRequire('./dateBuckets') as { dateBucketSql(col: string, bucket: unknown, dialect: unknown): string | null };

const { CompileError, qi } = core;

const COMPARE_SQL: Readonly<Record<string, string>> = Object.freeze({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' });
const NUMERIC_FNS = new Set(['count', 'countDistinct', 'sum', 'avg']);

export function newExtState(): ExtState {
    return { joins: [], joinParams: [], aggExprs: new Map() };
}

/** True when a groupBy entry uses the extended vocabulary. */
export function isExtendedGroupBy(g: Entry): boolean {
    return (g.relatedField !== undefined && g.relatedField !== null) || (g.binWidth !== undefined && g.binWidth !== null);
}

function isNumberField(f: Field | undefined): boolean {
    if (!f) return false;
    return f.type === 'number' || (f.type === 'computed' && !!f.computed && f.computed.type === 'number');
}

/** Whether an aggregate over this field yields a number. */
export function aggregateIsNumeric(fn: string, fm: FieldMap, field: unknown): boolean {
    if (NUMERIC_FNS.has(fn)) return true;
    return typeof field === 'string' && isNumberField(fm.get(field));
}

/** The related column of a groupBy entry, through a derived table under the target's access predicate. */
function relatedColumn(tableMeta: TableMeta, fm: FieldMap, g: Entry, related: RelatedTables | undefined, ext: ExtState): { col: string; field: Field | undefined } {
    if (typeof g.relatedField !== 'string' || !g.relatedField) throw new CompileError('relatedField must be a non-empty string');
    const fkCol = core.resolveColumn(tableMeta, g.field, fm);
    const relation = fm.get(g.field as string);
    if (!relation || relation.type !== 'relation') throw new CompileError(`groupBy relatedField needs a relation field: ${g.field}`);
    if (ext.joins.length >= AGGREGATE_LIMITS.MAX_RELATED_GROUP_BY) {
        throw new CompileError(`too many groupBy entries through a relation (max ${AGGREGATE_LIMITS.MAX_RELATED_GROUP_BY})`);
    }
    const target = related && Object.hasOwn(related, g.field as string) ? related[g.field as string] : null;
    if (!target) throw new CompileError(`the table behind relation "${g.field}" is not available`);
    core.assertTableMeta(target.tableMeta);
    core.assertAccessFilter(target.accessFilter);
    const want = relation.relation && relation.relation.table;
    if (!want || (want !== target.tableMeta.id && want !== target.tableMeta.key)) {
        throw new CompileError(`relation "${g.field}" does not point at that table`);
    }
    const targetFm = core.fieldMap(target.tableMeta);
    const col = core.resolveColumn(target.tableMeta, g.relatedField, targetFm);
    const alias = qi(`__rel_${ext.joins.length}`);
    ext.joins.push(`LEFT JOIN (SELECT ${qi('id')} AS ${qi('__rid')}, ${col} AS ${qi('__rv')} FROM ${qi(target.tableMeta.key as string)}`
        + ` WHERE (${target.accessFilter.where})) AS ${alias} ON ${alias}.${qi('__rid')} = ${qi(tableMeta.key as string)}.${fkCol}`);
    ext.joinParams.push(...target.accessFilter.params);
    return { col: `${alias}.${qi('__rv')}`, field: targetFm.get(g.relatedField) };
}

/** A number column folded onto the lower bound of its step: 0, 10, 20, … for width 10. */
function binSql(col: string, width: unknown, field: Field | undefined, dialect: string): string {
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > AGGREGATE_LIMITS.MAX_BIN_WIDTH) {
        throw new CompileError(`binWidth must be a whole number from 1 to ${AGGREGATE_LIMITS.MAX_BIN_WIDTH}`);
    }
    if (!isNumberField(field)) throw new CompileError('binWidth needs a number field');
    // Divided as a non-integer on both engines, so -7 lands in -10 and not in 0.
    return dialect === 'pg'
        ? `(FLOOR(${col}::numeric / ${width}) * ${width})`
        : `(FLOOR(CAST(${col} AS REAL) / ${width}) * ${width})`;
}

/**
 * The group expression and default alias of a groupBy entry that uses
 * relatedField and/or binWidth (a date bucket may still apply to a related
 * date column).
 */
export function extendedGroupBy(tableMeta: TableMeta, fm: FieldMap, g: Entry, dialect: string, related: RelatedTables | undefined, ext: ExtState): { expr: string; alias: string } {
    const hasBin = g.binWidth !== undefined && g.binWidth !== null;
    if (g.bucket && hasBin) throw new CompileError('a groupBy entry takes bucket or binWidth, not both');
    const viaRelation = g.relatedField !== undefined && g.relatedField !== null;
    const base = viaRelation
        ? relatedColumn(tableMeta, fm, g, related, ext)
        : { col: core.resolveColumn(tableMeta, g.field, fm), field: fm.get(g.field as string) };
    let expr = base.col;
    if (g.bucket) {
        if (!DATE_BUCKETS.includes(g.bucket as string)) throw new CompileError(`unknown date bucket: ${g.bucket}`);
        expr = dateBucketSql(base.col, g.bucket, dialect) as string;
    } else if (hasBin) {
        expr = binSql(base.col, g.binWidth, base.field, dialect);
    }
    const name = viaRelation ? `${g.field}_${g.relatedField}` : `${g.field}`;
    const suffix = g.bucket ? `_${g.bucket}` : hasBin ? '_bin' : '';
    return { expr, alias: `${name}${suffix}` };
}

/** COUNT(DISTINCT field): how many different values, empty ones not counted. */
export function countDistinctSql(tableMeta: TableMeta, fm: FieldMap, field: unknown): string {
    if (field === undefined || field === null || field === '*') throw new CompileError('countDistinct needs a field');
    return `COUNT(DISTINCT ${core.resolveColumn(tableMeta, field, fm)})`;
}

/**
 * ` HAVING …` for a groupFilter, or '' when the descriptor has none. Each entry
 * compares one number aggregate with a bound number; entries are ANDed.
 */
export function groupFilterSql(raw: unknown, ext: ExtState, params: unknown[]): string {
    if (raw === undefined || raw === null) return '';
    const max = AGGREGATE_LIMITS.MAX_GROUP_FILTERS;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
        throw new CompileError(`groupFilter must be a list of 1 to ${max} { field, op, value } entries`);
    }
    const parts = raw.map((entry) => {
        if (!entry || typeof entry !== 'object') throw new CompileError('groupFilter entry must be an object');
        const e = entry as Entry;
        const agg = typeof e.field === 'string' ? ext.aggExprs.get(e.field) : undefined;
        if (!agg) throw new CompileError(`groupFilter field "${e.field}" is not one of the aggregates`);
        if (!agg.numeric) throw new CompileError(`groupFilter on "${e.field}" needs an aggregate that yields a number`);
        if (!GROUP_FILTER_OPS.includes(e.op as string)) throw new CompileError(`unknown groupFilter op: ${e.op}`);
        if (typeof e.value !== 'number' || !Number.isFinite(e.value)) throw new CompileError('groupFilter value must be a number');
        params.push(e.value);
        return `${agg.expr} ${COMPARE_SQL[e.op as string]} ?`;
    });
    return ` HAVING ${parts.join(' AND ')}`;
}
