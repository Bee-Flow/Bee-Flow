/**
 * The filter tree: how a closed filter descriptor becomes the WHERE clause of a
 * read (and of the bulk writes, which share it).
 *
 * One clause per `{ field, op, value }` (or `{ field, op, otherField }`, two
 * columns of one row compared), groups `{ any: [...] }`, `{ all: [...] }` and
 * `{ not: entry }` nested to MAX_FILTER_DEPTH, a `match` combinator for the top
 * level, and the one fixed search group. The RLS access predicate is ALWAYS
 * present and ANDed first, OUTSIDE everything the client sent, so even a
 * zero-filter query is scoped and no OR or NOT in a group can widen it.
 *
 * Moved out of queryCompilerBase.js without a change to the SQL it emits
 * (queryCompiler.snapshot.test.js pins it). queryCompilerBase.buildWhere is the
 * positional entry point the compilers call; it delegates to compileWhere here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; computed?: { stored?: boolean } };
type TableMeta = { key?: string; fields?: Field[] };
type FieldMap = Map<string, Field>;
type AccessFilter = { where: string; params: unknown[] };
type Out = { sql: string[]; params: unknown[] };
type Clause = Record<string, unknown>;

/**
 * Everything compileWhere needs; the names of buildWhere's positional parameters.
 * `match` defaults to 'all' and `search` to none, as buildWhere's did.
 */
type WhereInput = {
    tableMeta: TableMeta;
    fm: FieldMap;
    filters: unknown;
    accessFilter: AccessFilter;
    dialect: string;
    match?: unknown;
    search?: unknown;
    /** Per relation field: the table it points at and the viewer's access predicate on it (queryCompilerRelation.mts). */
    related?: RelatedTables;
};

const core = nodeRequire('./queryCompilerCore') as {
    MAX_FILTERS: number;
    MAX_IN_VALUES: number;
    CompileError: new (message: string) => Error;
    resolveColumn(tableMeta: TableMeta, fieldName: unknown, fm?: FieldMap): string;
    scalar(v: unknown, dialect: string): string | number | boolean | null;
    assertAccessFilter(accessFilter: AccessFilter): void;
    fieldMap(tableMeta: TableMeta): FieldMap;
};
const { relationPath, relatedTarget, relationFilterSql, assertRelationFilterCount } = nodeRequire('./queryCompilerRelation.mts') as typeof import('./queryCompilerRelation.mts');
type RelatedTables = import('./queryCompilerRelation.mts').RelatedTables;
const { manyFilterSql } = nodeRequire('./queryCompilerMany.mts') as typeof import('./queryCompilerMany.mts');
const { FILTER_OPS, SYSTEM_COLUMNS } = nodeRequire('./dataModel/vocabulary') as { FILTER_OPS: readonly string[]; SYSTEM_COLUMNS: readonly string[] };
const { isAnyGroup, isAllGroup, isNotGroup, countFilterLeaves, MAX_FILTER_DEPTH, FIELD_COMPARE_OPS } = nodeRequire('../../shared/expr/filterGroups.mjs') as {
    isAnyGroup(entry: unknown): boolean;
    isAllGroup(entry: unknown): boolean;
    isNotGroup(entry: unknown): boolean;
    countFilterLeaves(filters: unknown[]): number;
    MAX_FILTER_DEPTH: number;
    FIELD_COMPARE_OPS: readonly string[];
};

const { CompileError, resolveColumn, scalar } = core;

// How the client filters join each other. ONE top-level combinator plus
// `any` / `all` / `not` groups to a fixed depth. The descriptor stays closed:
// a group holds only clauses and groups, every column still goes through
// resolveColumn and every value is still a bound parameter.
export const MATCH_MODES = Object.freeze(['all', 'any']);

// Escape LIKE metacharacters so a `contains`/`startsWith` value can't smuggle
// `%`/`_` wildcards. Paired with `ESCAPE '\'` in the emitted SQL.
function likeEscape(v: unknown): string {
    return String(v == null ? '' : v).replace(/[\\%_]/g, (c) => '\\' + c);
}

/** SQLite LIKE is ASCII-case-insensitive; pg ILIKE preserves that. */
const likeOf = (dialect: string): string => (dialect === 'pg' ? 'ILIKE' : 'LIKE');

/** One operator: append its SQL and its bound values to `out`. */
type OpEmitter = (col: string, filter: Clause, out: Out, dialect: string) => void;

const comparison = (sym: string): OpEmitter => (col, filter, out, dialect) => {
    out.sql.push(`${col} ${sym} ?`);
    out.params.push(scalar(filter.value, dialect));
};

const likeMatch = (prefix: string, suffix: string): OpEmitter => (col, filter, out, dialect) => {
    out.sql.push(`${col} ${likeOf(dialect)} ? ESCAPE '\\'`);
    out.params.push(prefix + likeEscape(filter.value) + suffix);
};

const emitEq: OpEmitter = (col, filter, out, dialect) => {
    // `ci: true` on a text match: equality without regard to case
    // (ILIKE/LIKE with no wildcard). Only for a string value.
    const ci = filter.ci === true && typeof filter.value === 'string';
    out.sql.push(ci ? `${col} ${likeOf(dialect)} ? ESCAPE '\\'` : `${col} = ?`);
    out.params.push(ci ? likeEscape(filter.value) : scalar(filter.value, dialect));
};

const emitNotContains: OpEmitter = (col, filter, out, dialect) => {
    // NOT (col LIKE ?), not `col NOT LIKE ?`: a NULL column makes the
    // bare NOT LIKE answer NULL, so the row is neither in nor out and
    // silently vanishes from a "does not contain" list.
    out.sql.push(`(${col} IS NULL OR NOT (${col} ${likeOf(dialect)} ? ESCAPE '\\'))`);
    out.params.push('%' + likeEscape(filter.value) + '%');
};

const listMembership = (op: 'in' | 'notIn'): OpEmitter => (col, filter, out, dialect) => {
    // A non-array is a MISTAKE, not "match nothing". Compiling a string value
    // to a literal FALSE silently would make a step
    // whose binding produced 'a,b' instead of ['a','b'] match zero
    // rows for ever and report success.
    if (!Array.isArray(filter.value)) {
        throw new CompileError(`${op} needs a list of values, not ${typeof filter.value}`);
    }
    const arr: unknown[] = filter.value;
    // IN () is invalid SQL → match nothing (and NOT IN () → everything).
    // sqlite accepts a falsy 0; pg's AND demands a boolean, so it gets a
    // literal FALSE/TRUE.
    if (arr.length === 0) {
        if (op === 'in') out.sql.push(dialect === 'pg' ? 'FALSE' : '0');
        else out.sql.push(dialect === 'pg' ? 'TRUE' : '1');
        return;
    }
    if (arr.length > core.MAX_IN_VALUES) throw new CompileError(`${op} filter exceeds ${core.MAX_IN_VALUES} values`);
    const holes = arr.map(() => '?').join(', ');
    // Same NULL problem as notContains: `col NOT IN (…)` is NULL for a
    // NULL column, so the row would disappear from both sides.
    out.sql.push(op === 'in'
        ? `${col} IN (${holes})`
        : `(${col} IS NULL OR ${col} NOT IN (${holes}))`);
    for (const v of arr) out.params.push(scalar(v, dialect));
};

const emitBetween: OpEmitter = (col, filter, out, dialect) => {
    const arr = Array.isArray(filter.value) ? filter.value : null;
    if (!arr || arr.length !== 2) throw new CompileError('between requires a [min, max] array');
    out.sql.push(`(${col} BETWEEN ? AND ?)`);
    out.params.push(scalar(arr[0], dialect), scalar(arr[1], dialect));
};

const nullTest = (test: string): OpEmitter => (col, _filter, out) => { out.sql.push(`${col} ${test}`); };

/** Every operator of FILTER_OPS and the SQL it emits. A Map, so no op name resolves to an inherited value. */
const OPS = new Map<string, OpEmitter>([
    ['eq', emitEq],
    ['neq', comparison('!=')],
    ['gt', comparison('>')],
    ['gte', comparison('>=')],
    ['lt', comparison('<')],
    ['lte', comparison('<=')],
    ['contains', likeMatch('%', '%')],
    ['notContains', emitNotContains],
    ['startsWith', likeMatch('', '%')],
    ['endsWith', likeMatch('%', '')],
    ['in', listMembership('in')],
    ['notIn', listMembership('notIn')],
    ['between', emitBetween],
    ['isNull', nullTest('IS NULL')],
    ['isNotNull', nullTest('IS NOT NULL')],
]);

/**
 * How two columns may be compared with each other: only within one class, so
 * the comparison means the same on both engines (Postgres refuses text against
 * a number; SQLite would answer by storage class). Null: not comparable.
 */
function compareClass(fieldName: string, fm: FieldMap): string | null {
    if (fieldName === 'created_at' || fieldName === 'updated_at') return 'datetime';
    if (SYSTEM_COLUMNS.includes(fieldName)) return 'text';
    const f = fm.get(fieldName);
    const type = f && f.type === 'computed' ? computedClass(f) : f && f.type;
    if (type === 'number' || type === 'bool' || type === 'date' || type === 'datetime') return type;
    if (type === 'multiselect' || type === 'file' || !type) return null;
    return 'text';
}

function computedClass(f: Field): string {
    const rt = (f.computed as { type?: string } | undefined)?.type;
    return rt === 'number' || rt === 'integer' ? 'number' : 'text';
}

const COMPARE_SYMBOL = new Map<string, string>([['eq', '='], ['neq', '!='], ['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<=']]);

/** `{ field, op, otherField }`: two columns of the same row, both resolved through the model. No bound value. */
function compileFieldCompare(tableMeta: TableMeta, fm: FieldMap, clause: Clause, col: string, out: Out): void {
    const other = resolveColumn(tableMeta, clause.otherField, fm);
    const sym = COMPARE_SYMBOL.get(clause.op as string);
    if (!sym || !FIELD_COMPARE_OPS.includes(clause.op as string)) {
        throw new CompileError(`a comparison with otherField takes one of ${FIELD_COMPARE_OPS.join(', ')}, not ${clause.op}`);
    }
    if (clause.value !== undefined && clause.value !== null) throw new CompileError('a filter clause takes a value or an otherField, not both');
    const left = compareClass(clause.field as string, fm);
    const right = compareClass(clause.otherField as string, fm);
    if (!left || left !== right) {
        throw new CompileError(`cannot compare "${clause.field}" with "${clause.otherField}": the two fields must be of the same kind (number, date, datetime, bool or text)`);
    }
    out.sql.push(`${col} ${sym} ${other}`);
}

/** One `{ field, op, value }` clause: the column is resolved first, then the operator is checked. */
export function compileFilter(tableMeta: TableMeta, fm: FieldMap, filter: unknown, out: Out, dialect: string): void {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new CompileError('filter must be an object');
    const clause = filter as Clause;
    const col = resolveColumn(tableMeta, clause.field, fm);
    const op = clause.op;
    if (typeof op !== 'string' || !FILTER_OPS.includes(op)) throw new CompileError(`unknown filter op: ${op}`);
    if (clause.otherField !== undefined && clause.otherField !== null) { compileFieldCompare(tableMeta, fm, clause, col, out); return; }
    const emit = OPS.get(op);
    if (!emit) throw new CompileError(`unsupported filter op: ${op}`);
    emit(col, clause, out, dialect);
}

/**
 * One `{ any: [entry, …] }` or `{ all: [entry, …] }` group: its entries OR
 * (AND) each other inside one parenthesised group, which ANDs with the other
 * top-level entries. Every clause goes through compileFilter, so the columns
 * and bound values stay as closed as ever. An `any` directly inside an `any`
 * is refused as before (a OR (b OR c) is a OR b OR c).
 */
function compileGroup(ctx: TreeCtx, group: Clause, key: 'any' | 'all', depth: number, out: Out): void {
    const members = group[key] as unknown[];
    if (group.field !== undefined) throw new CompileError(`a filter is either a clause with a field or an { ${key}: [...] } group, not both`);
    if (members.length === 0) throw new CompileError(`an { ${key}: [...] } filter group needs at least one clause`);
    const inner: Out = { sql: [], params: [] };
    for (const member of members) {
        if (key === 'any' && isAnyGroup(member)) throw new CompileError('an { any: [...] } filter group cannot hold another group');
        compileEntry(ctx, member, depth + 1, inner);
    }
    out.sql.push(inner.sql.length > 1 ? `(${inner.sql.join(key === 'any' ? ' OR ' : ' AND ')})` : inner.sql[0]);
    out.params.push(...inner.params);
}

/**
 * `{ not: entry }`: the rows the entry does NOT match. Two-valued on purpose:
 * a row for which the entry is unknown (a NULL column) is not matched by it,
 * so it belongs to the negation, the same way notContains and notIn keep rows
 * with an empty column.
 */
function compileNot(ctx: TreeCtx, group: Clause, depth: number, out: Out): void {
    const inner: Out = { sql: [], params: [] };
    compileEntry(ctx, group.not, depth + 1, inner);
    out.sql.push(`NOT COALESCE((${inner.sql[0]}), ${ctx.dialect === 'pg' ? 'FALSE' : '0'})`);
    out.params.push(...inner.params);
}

type TreeCtx = { tableMeta: TableMeta; fm: FieldMap; dialect: string; related?: RelatedTables; relationFilters: number };

/**
 * One clause: on a column of this table or, when the caller handed over the
 * related tables, `{ field: '<relation>.<column>', op, value }` on a column of
 * the row a relation points at (a subquery under that table's own access
 * predicate, see queryCompilerRelation.mts). Without `related` a dotted name is
 * an unknown field, as it always was.
 */
function compileClause(ctx: TreeCtx, entry: unknown, out: Out): void {
    const many = compileManyClause(ctx, entry);
    if (many) { out.sql.push(many.sql); out.params.push(...many.params); return; }
    const clause = ctx.related && entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Clause : null;
    const path = clause ? relationPath(clause.field) : null;
    if (!clause || !path) { compileFilter(ctx.tableMeta, ctx.fm, entry, out, ctx.dialect); return; }
    if (clause.otherField !== undefined && clause.otherField !== null) {
        throw new CompileError('a filter through a relation compares with a value, not with another column');
    }
    const fkColumn = resolveColumn(ctx.tableMeta, path.relation, ctx.fm);
    const target = relatedTarget(ctx.fm, path.relation, ctx.related, 'a filter');
    ctx.relationFilters += 1;
    assertRelationFilterCount(ctx.relationFilters);
    const inner: Out = { sql: [], params: [] };
    compileFilter(target.tableMeta, core.fieldMap(target.tableMeta), { ...clause, field: path.column }, inner, ctx.dialect);
    const built = relationFilterSql({ fkColumn, target }, { sql: inner.sql[0], params: inner.params });
    out.sql.push(built.sql);
    out.params.push(...built.params);
}

/**
 * `{ field: <many relation>, op: 'contains' | 'notContains', value: <id> }`: through the junction,
 * under the related table's access predicate (queryCompilerMany.mts). Null for any other clause.
 */
function compileManyClause(ctx: TreeCtx, entry: unknown): { sql: string; params: unknown[] } | null {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const clause = entry as Clause;
    if (typeof clause.field !== 'string') return null;
    const field = ctx.fm.get(clause.field) as Parameters<typeof manyFilterSql>[1];
    const target = ctx.related && Object.hasOwn(ctx.related, clause.field) ? ctx.related[clause.field] : undefined;
    return manyFilterSql(ctx.tableMeta, field, clause, target, ctx.dialect);
}

/** One entry of a filter list or of a group: a group (to MAX_FILTER_DEPTH) or a clause. */
function compileEntry(ctx: TreeCtx, entry: unknown, depth: number, out: Out): void {
    const group = isAnyGroup(entry) ? 'any' : isAllGroup(entry) ? 'all' : isNotGroup(entry) ? 'not' : null;
    if (group === null) { compileClause(ctx, entry, out); return; }
    if (depth >= MAX_FILTER_DEPTH) throw new CompileError(`filter groups nest at most ${MAX_FILTER_DEPTH} deep`);
    if (group === 'not') compileNot(ctx, entry as Clause, depth, out);
    else compileGroup(ctx, entry as Clause, group, depth, out);
}

/** The client filter list as clauses (still uncombined) and their bound values. */
function compileFilterList(tableMeta: TableMeta, fm: FieldMap, filters: unknown, dialect: string, related?: RelatedTables): Out {
    const out: Out = { sql: [], params: [] };
    if (filters == null) return out;
    if (!Array.isArray(filters)) throw new CompileError('filters must be an array');
    const leaves = countFilterLeaves(filters);
    if (leaves > core.MAX_FILTERS) throw new CompileError(`too many filters: ${leaves} clauses (max ${core.MAX_FILTERS}, counting the clauses inside any groups)`);
    const ctx: TreeCtx = { tableMeta, fm, dialect, related, relationFilters: 0 };
    for (const f of filters) compileEntry(ctx, f, 0, out);
    return out;
}

/**
 * ONE fixed extra group: "this word appears somewhere in the row".
 *
 * It is a named, server-built shape rather than a nested filter group. The
 * descriptor stays closed — every column still goes through resolveColumn
 * and the value is still a bound parameter — and the search ANDs with
 * whatever the filters said instead of joining their combinator, so a
 * `match:'any'` filter set cannot widen the search or the other way round.
 * Returns the clause, or null when no search was asked for; the values are
 * appended to `params`.
 */
function compileSearch(tableMeta: TableMeta, fm: FieldMap, search: unknown, dialect: string, params: unknown[]): string | null {
    if (!search || typeof search !== 'object') return null;
    const spec = search as Clause;
    const value = spec.value;
    const fields: unknown[] = Array.isArray(spec.fields) ? spec.fields : [];
    if (typeof value !== 'string' || !value) throw new CompileError('search needs a non-empty string');
    if (!fields.length) throw new CompileError('search needs at least one column to look in');
    if (fields.length > core.MAX_FILTERS) throw new CompileError(`search spans at most ${core.MAX_FILTERS} columns`);
    const like = likeOf(dialect);
    const parts: string[] = [];
    for (const f of fields) {
        parts.push(`${resolveColumn(tableMeta, f, fm)} ${like} ? ESCAPE '\\'`);
        params.push('%' + likeEscape(value) + '%');
    }
    return `(${parts.join(' OR ')})`;
}

/**
 * Build a WHERE clause combining the (validated) client filters with the RLS
 * access predicate. The access predicate is ALWAYS present and ANDed first, so
 * even a zero-filter query is scoped.
 *
 * With `match: 'any'` the CLIENT filters OR each other inside one parenthesised
 * group and the access predicate stays ANDed OUTSIDE it. That placement is the
 * whole security story: `access OR status='new'` would hand every row of the
 * table to anyone who asked for the right status.
 */
export function compileWhere({ tableMeta, fm, filters, accessFilter, dialect, match = 'all', search = null, related }: WhereInput): { where: string; params: unknown[] } {
    core.assertAccessFilter(accessFilter);
    if (!MATCH_MODES.includes(match as string)) throw new CompileError(`match must be one of ${MATCH_MODES.join(', ')}`);
    const out = compileFilterList(tableMeta, fm, filters, dialect, related);
    const user = (match === 'any' && out.sql.length > 1)
        ? [`(${out.sql.join(' OR ')})`]
        : out.sql;
    const clauses = [`(${accessFilter.where})`, ...user];
    const params = [...accessFilter.params, ...out.params];
    const searchClause = compileSearch(tableMeta, fm, search, dialect, params);
    if (searchClause !== null) clauses.push(searchClause);
    return { where: 'WHERE ' + clauses.join(' AND '), params };
}
