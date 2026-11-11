/**
 * What a RECORD read does through relations, and which columns it returns:
 * the `read` argument of queryCompiler.compileRecordList, and the step that
 * runs after the list.
 *
 *   relationRead(model, tableMeta, { filters, expand, fields }, who)
 *       builds `{ related, expand, fields }` from the request and the model.
 *       The related tables and the viewer's access predicate on each come from
 *       aggregateRelated.relatedTablesFor, under the role and viewer the main
 *       access filter was compiled with. Undefined when the read uses none of
 *       the three, so such a read compiles exactly as before.
 *   finishRecords(compiled, rows, query)
 *       runs the expansion lookups of a compiled list (one query per relation
 *       and batch of ids, never a join), puts each related row on its record
 *       (null when the relation is empty or the viewer may not read the row it
 *       points at), and drops every key the read did not ask for. Returns the
 *       rows untouched when the compiled list carries neither.
 *
 * Every read path that serves records calls both, so a second door onto the
 * same data cannot expand a row the first one would have hidden.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type AccessFilter = { where: string; params: unknown[] };
type Table = { id?: string; key?: string; fields?: unknown[]; source?: unknown };
type Related = Record<string, { tableMeta: Table; accessFilter: AccessFilter }>;
type ExpandPlan = { field: string; as: string; target: { tableMeta: Table; accessFilter: AccessFilter }; pick: string[]; label: string | null; dialect: string };
type Compiled = { expand?: ExpandPlan[]; project?: string[] };
type Query = (sql: string, params: unknown[]) => Promise<{ rows?: Row[] } | Row[]>;

const { relatedTablesFor, relationFilterFields } = nodeRequire('./aggregateRelated.mts') as {
    relatedTablesFor(model: unknown, tableMeta: Table, keys: string[], who: unknown): Related;
    relationFilterFields(filters: unknown): string[];
};
const { compileExpandLookup, EXPAND_LOOKUP_BATCH } = nodeRequire('./queryCompilerRelation.mts') as {
    compileExpandLookup(plan: ExpandPlan, ids: unknown[]): { sql: string; params: unknown[] };
    EXPAND_LOOKUP_BATCH: number;
};
const { EXPAND_LABEL_KEY } = nodeRequire('./dataModel/vocabulary') as { EXPAND_LABEL_KEY: string };

/** The predicate aggregateRelated hands over for a table the role may not read. */
const NO_ROWS_WHERE = '1=0';

const present = (v: unknown): boolean => v !== undefined && v !== null;

function expandFields(expand: unknown): string[] {
    if (!Array.isArray(expand)) return [];
    return expand.map((e) => (e && typeof e === 'object' ? (e as Row).field : undefined)).filter((f): f is string => typeof f === 'string');
}

/**
 * @param model       the app's data model ({ tables }); null for a table whose rows live outside the app
 * @param tableMeta   the table the read lists, as compiled
 * @param descriptor  the request: `filters`, `expand`, `fields`
 * @param who         the role, viewer and dialect the main access filter was compiled with
 */
export function relationRead(
    model: unknown,
    tableMeta: Table,
    descriptor: { filters?: unknown; expand?: unknown; fields?: unknown } | null | undefined,
    who: { role: unknown; viewer: unknown; dialect?: string },
): { related: Related; expand?: unknown; fields?: unknown } | undefined {
    const d = descriptor || {};
    const keys = [...new Set([...relationFilterFields(d.filters), ...expandFields(d.expand)])];
    if (keys.length === 0 && !present(d.expand) && !present(d.fields)) return undefined;
    const out: { related: Related; expand?: unknown; fields?: unknown } = { related: relatedTablesFor(model as { tables?: unknown }, tableMeta, keys, who) };
    if (present(d.expand)) out.expand = d.expand;
    if (present(d.fields)) out.fields = d.fields;
    return out;
}

/** The related rows of one relation, by id: one lookup per batch of ids. */
async function lookUp(plan: ExpandPlan, rows: Row[], query: Query): Promise<Map<string, Row>> {
    const found = new Map<string, Row>();
    const ids = [...new Set(rows.map((r) => r[plan.field]).filter((v): v is string | number => (typeof v === 'string' && v !== '') || typeof v === 'number'))];
    for (let i = 0; i < ids.length; i += EXPAND_LOOKUP_BATCH) {
        const { sql, params } = compileExpandLookup(plan, ids.slice(i, i + EXPAND_LOOKUP_BATCH));
        const res = await query(sql, params);
        for (const hit of (Array.isArray(res) ? res : res.rows) || []) {
            const out: Row = { id: hit.id };
            for (const key of plan.pick) out[key] = hit[key];
            if (plan.label) out[EXPAND_LABEL_KEY] = hit[plan.label];
            found.set(String(hit.id), out);
        }
    }
    return found;
}

function project(row: Row, keys: string[]): Row {
    const out: Row = { id: row.id };
    for (const key of keys) if (Object.hasOwn(row, key)) out[key] = row[key];
    return out;
}

/**
 * @param compiled  what compileRecordList returned
 * @param rows      the page, already trimmed of its probe row
 * @param query     runs SQL against the storage the list was read from
 */
export async function finishRecords<R extends Row>(compiledList: object | null | undefined, rows: R[], query: Query): Promise<R[] | Row[]> {
    const compiled = compiledList as Compiled | null | undefined;
    const plans = compiled && Array.isArray(compiled.expand) ? compiled.expand : [];
    const keys = compiled && Array.isArray(compiled.project) ? compiled.project : null;
    if (plans.length === 0 && !keys) return rows;
    let out: Row[] = rows.map((r) => ({ ...r }));
    for (const plan of plans) {
        // A role that may not read the related table at all: nothing to look up, every expansion is null.
        const found = plan.target.accessFilter.where === NO_ROWS_WHERE ? new Map<string, Row>() : await lookUp(plan, out, query);
        for (const row of out) {
            const id = row[plan.field];
            row[plan.as] = (typeof id === 'string' || typeof id === 'number') && found.has(String(id)) ? found.get(String(id)) : null;
        }
    }
    if (keys) out = out.map((r) => project(r, keys));
    return out;
}
