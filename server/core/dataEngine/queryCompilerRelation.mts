/**
 * Reading through a relation, one relation deep (RELATION_READ_LIMITS in
 * dataModel/vocabulary.js):
 *
 *   expand   the related row of each record. NEVER a SQL join: the record list
 *            is read as always, and each relation is then looked up with ONE
 *            more query per batch of ids, the shape of compileKeyIndex:
 *
 *              SELECT "id", <picked columns> FROM "<target>"
 *               WHERE (<target access>) AND "id" IN (?, ?, …)
 *
 *            A related row the viewer may not read is not in that answer, so
 *            it expands to null, exactly like a relation that points nowhere.
 *   filter   `{ field: '<relation>.<column>', op, value }` compiles to
 *
 *              "<fk>" IN (SELECT "id" FROM "<target>"
 *                          WHERE (<target access>) AND <column> <op> ?)
 *
 *            so a record whose related row the viewer may not read matches no
 *            such filter, whatever its value: a filter tells nothing about a
 *            row the viewer cannot see.
 *   fields   the select list of the record read: `id`, the listed columns, and
 *            what the read itself needs (sort columns for the cursor, relation
 *            columns for the expansion); relationRead.mts drops the extras
 *            before the rows leave.
 *
 * The related table and the viewer's access predicate on it come ONLY from the
 * caller (relationRead.mts), never from the descriptor. A relation the caller
 * did not hand over is refused, never read unscoped.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; relation?: { table?: string; displayField?: string }; computed?: { stored?: boolean } };
type TableMeta = { id?: string; key?: string; fields?: Field[] };
type FieldMap = Map<string, Field>;
type AccessFilter = { where: string; params: unknown[] };
type Entry = Record<string, unknown>;

/** The table a relation field points at, with the viewer's access predicate on it. */
export type RelatedTable = { tableMeta: TableMeta; accessFilter: AccessFilter };
/** Keyed by the relation field's key on the table that is read. */
export type RelatedTables = Record<string, RelatedTable>;

/** One relation to expand, resolved against the model. */
export type ExpandPlan = {
    /** The relation field on the table that is read. */
    field: string;
    /** The key of a record the related row lands in. */
    as: string;
    target: RelatedTable;
    /** Field keys of the related table that leave the server (next to `id`). */
    pick: string[];
    /** The related table's display column (relation.displayField), or null. */
    label: string | null;
    dialect: string;
};

const core = nodeRequire('./queryCompilerCore') as {
    ALIAS_RE: RegExp;
    CompileError: new (message: string) => Error;
    qi(name: string): string;
    assertTableMeta(tableMeta: TableMeta): void;
    assertAccessFilter(accessFilter: unknown): void;
    fieldMap(tableMeta: TableMeta): FieldMap;
    resolveColumn(tableMeta: TableMeta, fieldName: unknown, fm?: FieldMap): string;
    scalar(v: unknown, dialect: string): string | number | boolean | null;
};
const { RELATION_READ_LIMITS, EXPAND_DEFAULT_SUFFIX, SYSTEM_COLUMNS } = nodeRequire('./dataModel/vocabulary') as {
    RELATION_READ_LIMITS: { MAX_EXPAND: number; MAX_EXPAND_PICK: number; MAX_FIELDS: number; MAX_RELATION_FILTERS: number };
    EXPAND_DEFAULT_SUFFIX: string;
    SYSTEM_COLUMNS: readonly string[];
};

const { CompileError, qi } = core;

/** How many ids one expansion lookup binds; a page of records is looked up in batches of this size. */
export const EXPAND_LOOKUP_BATCH = 200;

/** `'<relation>.<column>'` → its two parts; null for a plain field name. */
export function relationPath(field: unknown): { relation: string; column: string } | null {
    if (typeof field !== 'string') return null;
    const dot = field.indexOf('.');
    if (dot < 0) return null;
    const relation = field.slice(0, dot);
    const column = field.slice(dot + 1);
    if (!relation || !column || column.includes('.')) {
        throw new CompileError(`"${field}" is not <relation field>.<field of the related table>: a read goes one relation deep`);
    }
    return { relation, column };
}

/**
 * The table behind a relation field, as the caller handed it over. Refuses a
 * field that is not a relation, a relation the caller did not resolve (a table
 * outside this app's own storage, such as a linked Studio table), and a
 * handed-over table the relation does not point at.
 */
export function relatedTarget(fm: FieldMap, fieldKey: unknown, related: RelatedTables | undefined, what: string): RelatedTable {
    const field = typeof fieldKey === 'string' ? fm.get(fieldKey) : undefined;
    if (!field || field.type !== 'relation') throw new CompileError(`${what} needs a relation field; "${fieldKey}" is not one`);
    const key = fieldKey as string;
    const target = related && Object.hasOwn(related, key) ? related[key] : null;
    if (!target) {
        throw new CompileError(`${what} cannot read through "${key}": it does not point at a table of this app that keeps its own rows (a linked Studio table cannot be read through a relation)`);
    }
    core.assertTableMeta(target.tableMeta);
    core.assertAccessFilter(target.accessFilter);
    const want = field.relation && field.relation.table;
    if (!want || (want !== target.tableMeta.id && want !== target.tableMeta.key)) {
        throw new CompileError(`relation "${key}" does not point at that table`);
    }
    return target;
}

/**
 * The SQL of one `{ field: '<relation>.<column>', … }` filter clause. `inner`
 * compiles the clause on the related table's column (the caller's own clause
 * compiler, so every operator means what it means on a plain column).
 */
export function relationFilterSql(
    parts: { fkColumn: string; target: RelatedTable },
    inner: { sql: string; params: unknown[] },
): { sql: string; params: unknown[] } {
    const { fkColumn, target } = parts;
    return {
        sql: `${fkColumn} IN (SELECT ${qi('id')} FROM ${qi(target.tableMeta.key as string)} WHERE (${target.accessFilter.where}) AND ${inner.sql})`,
        params: [...target.accessFilter.params, ...inner.params],
    };
}

/** Too many relation filters in one read. */
export function assertRelationFilterCount(count: number): void {
    const max = RELATION_READ_LIMITS.MAX_RELATION_FILTERS;
    if (count > max) throw new CompileError(`too many filters through a relation (max ${max})`);
}

function isReadableColumn(tableMeta: TableMeta, fm: FieldMap, key: string): boolean {
    if (SYSTEM_COLUMNS.includes(key)) return true;
    const f = fm.get(key);
    return !!f && !(f.type === 'computed' && !(f.computed && f.computed.stored === true));
}

function pickOf(entry: Entry, target: RelatedTable, targetFm: FieldMap, label: string | null): string[] {
    if (entry.pick === undefined || entry.pick === null) return label ? [label] : [];
    const max = RELATION_READ_LIMITS.MAX_EXPAND_PICK;
    if (!Array.isArray(entry.pick) || entry.pick.length === 0 || entry.pick.length > max) {
        throw new CompileError(`expand pick must be a list of 1 to ${max} fields of the related table`);
    }
    const out: string[] = [];
    for (const key of entry.pick) {
        core.resolveColumn(target.tableMeta, key, targetFm); // throws on a name that is not a real column
        if (!out.includes(key as string)) out.push(key as string);
    }
    return out;
}

function aliasOf(entry: Entry, tableMeta: TableMeta, fm: FieldMap, taken: Set<string>): string {
    const explicit = entry.as !== undefined && entry.as !== null;
    const as = explicit ? entry.as : `${entry.field}${EXPAND_DEFAULT_SUFFIX}`;
    if (typeof as !== 'string' || !core.ALIAS_RE.test(as)) throw new CompileError(`invalid expand alias: ${as}`);
    if (fm.has(as) || SYSTEM_COLUMNS.includes(as)) {
        throw new CompileError(`expand alias "${as}" is a column of "${tableMeta.key}"; ${explicit ? 'pick another name' : 'name the expansion with `as`'}`);
    }
    if (taken.has(as)) throw new CompileError(`expand alias "${as}" is used twice`);
    taken.add(as);
    return as;
}

/** `expand` → one plan per entry, every name resolved through the two models. */
export function resolveExpand(tableMeta: TableMeta, fm: FieldMap, expand: unknown, related: RelatedTables | undefined, dialect: string): ExpandPlan[] {
    if (expand === undefined || expand === null) return [];
    const max = RELATION_READ_LIMITS.MAX_EXPAND;
    if (!Array.isArray(expand) || expand.length === 0 || expand.length > max) {
        throw new CompileError(`expand must be a list of 1 to ${max} { field, pick?, as? } entries`);
    }
    const taken = new Set<string>();
    return expand.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CompileError('expand entry must be an object');
        const entry = raw as Entry;
        if (entry.expand !== undefined && entry.expand !== null) throw new CompileError('expand goes one relation deep: an entry cannot expand further');
        core.resolveColumn(tableMeta, entry.field, fm);
        const target = relatedTarget(fm, entry.field, related, 'expand');
        const targetFm = core.fieldMap(target.tableMeta);
        const display = (fm.get(entry.field as string) as Field).relation?.displayField;
        const label = typeof display === 'string' && isReadableColumn(target.tableMeta, targetFm, display) ? display : null;
        return {
            field: entry.field as string,
            as: aliasOf(entry, tableMeta, fm, taken),
            target,
            pick: pickOf(entry, target, targetFm, label),
            label,
            dialect,
        };
    });
}

/**
 * The lookup of one batch of related rows: `id` plus the picked columns (and
 * the display column), under the related table's access predicate.
 */
export function compileExpandLookup(plan: ExpandPlan, ids: unknown[]): { sql: string; params: unknown[] } {
    const list = (Array.isArray(ids) ? ids : []).filter((k) => k !== null && k !== undefined && k !== '');
    if (!list.length) throw new CompileError('compileExpandLookup requires at least one id');
    if (list.length > EXPAND_LOOKUP_BATCH) throw new CompileError(`compileExpandLookup accepts at most ${EXPAND_LOOKUP_BATCH} ids per call`);
    const { tableMeta, accessFilter } = plan.target;
    const targetFm = core.fieldMap(tableMeta);
    const keys = ['id', ...plan.pick, ...(plan.label ? [plan.label] : [])].filter((k, i, all) => all.indexOf(k) === i);
    const select = keys.map((k) => `${core.resolveColumn(tableMeta, k, targetFm)} AS ${qi(k)}`).join(', ');
    return {
        sql: `SELECT ${select} FROM ${qi(tableMeta.key as string)} WHERE (${accessFilter.where}) AND ${qi('id')} IN (${list.map(() => '?').join(', ')})`,
        params: [...accessFilter.params, ...list.map((k) => core.scalar(k, plan.dialect))],
    };
}

/** What the server hands compileRecordList to read through relations and narrow the columns. */
export type RelationRead = { related?: RelatedTables; expand?: unknown; fields?: unknown };

/**
 * What `read` adds to a record list: `result` (the expansions to look up after
 * the list and the keys a record keeps, each only when the read asks for it)
 * and the select list that serves both: nothing (every column) unless the read
 * names its fields, then `id`, those fields, the sort columns the cursor is
 * minted from and the relation columns the expansions look up.
 */
export function recordShape(tableMeta: TableMeta, fm: FieldMap, read: RelationRead, dialect: string): {
    result: { expand?: ExpandPlan[]; project?: string[] };
    select(orderColumns: string[]): string[] | undefined;
} {
    const expand = resolveExpand(tableMeta, fm, read.expand, read.related, dialect);
    const fields = resolveFields(tableMeta, fm, read.fields);
    const result: { expand?: ExpandPlan[]; project?: string[] } = {};
    if (expand.length) result.expand = expand;
    if (fields) result.project = [...fields, ...expand.map((e) => e.as)];
    const column = (k: string): string => core.resolveColumn(tableMeta, k, fm);
    return {
        result,
        select: (orderColumns) => (fields
            ? [qi('id'), ...fields.map(column), ...orderColumns, ...expand.map((e) => column(e.field))]
            : undefined),
    };
}

/**
 * `fields` → the field keys a record read returns next to `id`. A read-time
 * computed field has no column to select, so it is left out (it reads empty
 * today as well); any other unknown name is refused.
 */
export function resolveFields(tableMeta: TableMeta, fm: FieldMap, fields: unknown): string[] | null {
    if (fields === undefined || fields === null) return null;
    const max = RELATION_READ_LIMITS.MAX_FIELDS;
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > max) {
        throw new CompileError(`fields must be a list of 1 to ${max} field names`);
    }
    const out: string[] = [];
    for (const key of fields) {
        if (typeof key !== 'string' || !key) throw new CompileError('field must be a non-empty string');
        if (!SYSTEM_COLUMNS.includes(key) && !fm.has(key)) throw new CompileError(`unknown field: ${key}`);
        if (isReadableColumn(tableMeta, fm, key) && !out.includes(key)) out.push(key);
    }
    return out;
}
