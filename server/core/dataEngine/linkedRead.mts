/**
 * The values of the fields that have no column (dataModel/linkedFields.js), filled into a page of
 * records after the list itself was read. Every one of them is read under the row rules of the
 * table it reads from, for the role and viewer the list was read with:
 *
 *   lookup   one field of the row a relation points at: one query per relation and batch of ids
 *            (compileExpandLookup, the expansion's own lookup). A related row the viewer may not
 *            read is not in the answer, so the lookup reads null, as for an empty relation.
 *   rollup   count / sum / min / max / avg over the child rows that point at each record: one
 *            grouped query per batch of ids, the child table's access predicate and the rollup's
 *            own filter ANDed in its WHERE. A child the viewer may not read is not counted; no
 *            readable child gives 0 for count and null for the others.
 *   many     the ids of a many relation, from its junction, each to a row the viewer may read
 *            (queryCompilerMany.mts). Always a list.
 *
 * linkedReadPlan resolves the fields and the access predicates once (undefined for a table
 * without such a field, so its reads run exactly as before); fillLinked runs the queries.
 * relationRead.mts calls both, so every record read path that expands also fills these.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Field = { id?: string; key?: string; type?: string; relation?: { table?: string; many?: boolean }; lookup?: unknown; rollup?: unknown };
type Table = { id?: string; key?: string; fields?: Field[]; source?: unknown };
type AccessFilter = { where: string; params: unknown[] };
type Target = { tableMeta: Table; accessFilter: AccessFilter };
type Who = { role: unknown; viewer: unknown; dialect?: string };
type Query = (sql: string, params: unknown[]) => Promise<{ rows?: Row[] } | Row[]>;

type LookupGroup = { relation: string; target: Target; picks: Array<{ key: string; field: string }> };
type Rollup = { key: string; fn: string; child: Target; fk: string; field: string | null; filter: unknown[] };
type Many = { key: string; field: Field; target: Target };

/** What fillLinked needs; `columns` are the relation columns a narrowed read must still select. */
export type LinkedPlan = { table: Table; dialect: string; columns: string[]; lookups: LookupGroup[]; rollups: Rollup[]; many: Many[]; nulls: string[] };

const { relatedTablesFor } = nodeRequire('./aggregateRelated.mts') as {
    relatedTablesFor(model: unknown, tableMeta: Table, keys: string[], who: Who): Record<string, Target>;
};
const accessFilter = nodeRequire('./accessFilter') as {
    canRead(table: Table, role: unknown): boolean;
    compileAccessFilter(table: Table, role: unknown, viewer: unknown, action: string, opts?: { dialect?: string }): AccessFilter;
};
const { compileExpandLookup, EXPAND_LOOKUP_BATCH } = nodeRequire('./queryCompilerRelation.mts') as {
    compileExpandLookup(plan: { field: string; as: string; target: Target; pick: string[]; label: null; dialect: string }, ids: unknown[]): { sql: string; params: unknown[] };
    EXPAND_LOOKUP_BATCH: number;
};
const { compileLinkRead } = nodeRequire('./queryCompilerMany.mts') as typeof import('./queryCompilerMany.mts');
const { compileWhere } = nodeRequire('./queryCompilerFilter.mts') as typeof import('./queryCompilerFilter.mts');
const core = nodeRequire('./queryCompilerCore') as {
    qi(name: string): string;
    fieldMap(tableMeta: Table): Map<string, Field>;
    resolveColumn(tableMeta: Table, fieldName: unknown, fm?: Map<string, Field>): string;
    scalar(v: unknown, dialect: string): string | number | boolean | null;
};
const { isManyRelation } = nodeRequire('./dataModel/linkedFields') as { isManyRelation(f: unknown): boolean };
const { resolveDialect } = nodeRequire('./engineFlag') as { resolveDialect(o: { dialect?: string }): string };

/** The predicate aggregateRelated hands over for a table the role may not read. */
const NO_ROWS = '1=0';
const AGG_SQL: Readonly<Record<string, string>> = Object.freeze({ sum: 'SUM', min: 'MIN', max: 'MAX', avg: 'AVG' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function tablesOf(model: unknown): Table[] {
    return (isObject(model) && Array.isArray(model.tables) ? model.tables : []) as Table[];
}

/** The child table and its relation field a rollup counts through, or null when the model does not resolve it. */
function rollupChild(model: unknown, table: Table, spec: Record<string, unknown>): { child: Table; fk: string } | null {
    const ref = str(spec.table);
    const child = ref ? tablesOf(model).find((t) => t && (t.id === ref || t.key === ref)) : undefined;
    if (!child || (child.source !== undefined && child.source !== null)) return null;
    const fk = (child.fields || []).find((f) => f && f.key === spec.relation);
    const points = fk && fk.type === 'relation' && !isManyRelation(fk) && fk.relation ? fk.relation.table : undefined;
    if (!fk || (points !== table.id && points !== table.key)) return null;
    return { child, fk: fk.key as string };
}

function childTarget(child: Table, who: Who, dialect: string): Target {
    const filter = accessFilter.canRead(child, who.role)
        ? accessFilter.compileAccessFilter(child, who.role, who.viewer, 'read', { dialect })
        : { where: NO_ROWS, params: [] };
    return { tableMeta: child, accessFilter: filter };
}

function lookupGroups(model: unknown, table: Table, fields: Field[], who: Who): LookupGroup[] {
    const specs = fields.filter((f) => f.type === 'lookup' && isObject(f.lookup) && str(f.lookup.relation) && str(f.lookup.field));
    const keys = [...new Set(specs.map((f) => (f.lookup as Record<string, string>).relation))];
    const related = keys.length ? relatedTablesFor(model, table, keys, who) : {};
    const groups: LookupGroup[] = [];
    for (const key of keys) {
        if (!Object.hasOwn(related, key)) continue;
        const picks = specs.filter((f) => (f.lookup as Record<string, string>).relation === key)
            .map((f) => ({ key: f.key as string, field: (f.lookup as Record<string, string>).field }));
        groups.push({ relation: key, target: related[key], picks });
    }
    return groups;
}

/**
 * @param model   the app's data model ({ tables })
 * @param table   the table the read lists, as compiled
 * @param who     the role, viewer and dialect the list's access filter was compiled with
 * @param wanted  the field keys the read keeps (its `fields` plus what it expands), or null for all
 */
export function linkedReadPlan(model: unknown, table: Table, who: Who, wanted: string[] | null = null): LinkedPlan | undefined {
    if (!model || !table || (table.source !== undefined && table.source !== null)) return undefined;
    const dialect = resolveDialect({ dialect: who.dialect });
    const fields = (Array.isArray(table.fields) ? table.fields : [])
        .filter((f) => f && typeof f.key === 'string' && (!wanted || wanted.includes(f.key)));
    const lookups = lookupGroups(model, table, fields, who);
    const rollups: Rollup[] = [];
    for (const f of fields) {
        if (f.type !== 'rollup' || !isObject(f.rollup)) continue;
        const found = rollupChild(model, table, f.rollup);
        if (!found) continue;
        const spec = f.rollup;
        rollups.push({ key: f.key as string, fn: String(spec.fn), child: childTarget(found.child, who, dialect), fk: found.fk, field: str(spec.field), filter: Array.isArray(spec.filter) ? spec.filter : [] });
    }
    const manyFields = fields.filter((f) => isManyRelation(f));
    const related = manyFields.length ? relatedTablesFor(model, table, manyFields.map((f) => f.key as string), who) : {};
    const many = manyFields.filter((f) => Object.hasOwn(related, f.key as string)).map((f) => ({ key: f.key as string, field: f, target: related[f.key as string] }));
    const linked = fields.filter((f) => (f.type === 'lookup' || f.type === 'rollup' || isManyRelation(f))).map((f) => f.key as string);
    if (!linked.length) return undefined;
    // A field the model does not resolve (a relation to a linked Studio table) reads null.
    const covered = new Set([...lookups.flatMap((g) => g.picks.map((p) => p.key)), ...rollups.map((r) => r.key), ...many.map((m) => m.key)]);
    return { table, dialect, columns: lookups.map((g) => g.relation), lookups, rollups, many, nulls: linked.filter((k) => !covered.has(k)) };
}

async function rowsOf(query: Query, sql: string, params: unknown[]): Promise<Row[]> {
    const res = await query(sql, params);
    return (Array.isArray(res) ? res : res.rows) || [];
}

function batches<T>(list: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);

async function fillLookups(plan: LinkedPlan, group: LookupGroup, rows: Row[], query: Query): Promise<void> {
    const found = new Map<string, Row>();
    const ids = [...new Set(rows.map((r) => idOf(r[group.relation])).filter((v): v is string => v !== null))];
    if (group.target.accessFilter.where !== NO_ROWS) {
        const lookup = { field: group.relation, as: group.relation, target: group.target, pick: [...new Set(group.picks.map((p) => p.field))], label: null, dialect: plan.dialect };
        for (const batch of batches(ids, EXPAND_LOOKUP_BATCH)) {
            const { sql, params } = compileExpandLookup(lookup, batch);
            for (const hit of await rowsOf(query, sql, params)) found.set(String(hit.id), hit);
        }
    }
    for (const row of rows) {
        const id = idOf(row[group.relation]);
        const hit = id === null ? undefined : found.get(id);
        for (const p of group.picks) row[p.key] = hit && hit[p.field] !== undefined ? hit[p.field] : null;
    }
}

function rollupSql(plan: LinkedPlan, r: Rollup, ids: string[]): { sql: string; params: unknown[] } {
    const { tableMeta } = r.child;
    const fm = core.fieldMap(tableMeta);
    const fk = core.resolveColumn(tableMeta, r.fk, fm);
    const agg = r.fn === 'count' ? 'COUNT(*)' : `${AGG_SQL[r.fn]}(${core.resolveColumn(tableMeta, r.field, fm)})`;
    const { where, params } = compileWhere({ tableMeta, fm, filters: r.filter, accessFilter: r.child.accessFilter, dialect: plan.dialect });
    return {
        sql: `SELECT ${fk} AS ${core.qi('k')}, ${agg} AS ${core.qi('v')} FROM ${core.qi(tableMeta.key as string)} ${where} `
            + `AND ${fk} IN (${ids.map(() => '?').join(', ')}) GROUP BY ${fk}`,
        params: [...params, ...ids.map((id) => core.scalar(id, plan.dialect))],
    };
}

async function fillRollup(plan: LinkedPlan, r: Rollup, rows: Row[], query: Query): Promise<void> {
    if (r.fn !== 'count' && !Object.hasOwn(AGG_SQL, r.fn)) return;
    const found = new Map<string, unknown>();
    const ids = [...new Set(rows.map((row) => idOf(row.id)).filter((v): v is string => v !== null))];
    if (r.child.accessFilter.where !== NO_ROWS) {
        for (const batch of batches(ids, EXPAND_LOOKUP_BATCH)) {
            const { sql, params } = rollupSql(plan, r, batch);
            for (const hit of await rowsOf(query, sql, params)) found.set(String(hit.k), hit.v);
        }
    }
    for (const row of rows) {
        const v = found.get(String(row.id));
        // Postgres answers COUNT and SUM over NUMERIC as text.
        row[r.key] = v === undefined || v === null ? (r.fn === 'count' ? 0 : null) : Number(v);
    }
}

async function fillMany(plan: LinkedPlan, m: Many, rows: Row[], query: Query): Promise<void> {
    const links = new Map<string, string[]>();
    const ids = [...new Set(rows.map((row) => idOf(row.id)).filter((v): v is string => v !== null))];
    if (m.target.accessFilter.where !== NO_ROWS) {
        for (const batch of batches(ids, EXPAND_LOOKUP_BATCH)) {
            const { sql, params } = compileLinkRead(plan.table, m.field, m.target, batch, plan.dialect);
            for (const hit of await rowsOf(query, sql, params)) {
                const key = String(hit.s);
                links.set(key, [...(links.get(key) || []), String(hit.t)]);
            }
        }
    }
    for (const row of rows) row[m.key] = links.get(String(row.id)) || [];
}

/** Fill every lookup, rollup and many relation of `plan` into `rows` (written in place). */
export async function fillLinked(plan: LinkedPlan | undefined, rows: Row[], query: Query): Promise<void> {
    if (!plan || !rows.length) return;
    for (const row of rows) for (const key of plan.nulls) row[key] = null;
    for (const group of plan.lookups) await fillLookups(plan, group, rows, query);
    for (const r of plan.rollups) await fillRollup(plan, r, rows, query);
    for (const m of plan.many) await fillMany(plan, m, rows, query);
}
