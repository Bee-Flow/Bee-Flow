/**
 * App Studio action executor: the links of a many relation (`relation.many: true`) on the
 * one-record writes of records.js (writeRecord, writeRecordBatch). The links are not a column:
 * they go to the relation's junction in the SAME transaction as the row itself.
 *
 *   splitLinks(table, values)      the values without the many relations, and the id lists
 *   linkStatements(...)            the statements that replace the links of one record
 *
 * Every id is viewer input. Before anything is written, each listed id must be a row of the
 * related table the writer may READ (one COUNT under that table's access predicate); an id that
 * is not is a 422 naming the field, never a link written in silence. The statements themselves
 * repeat the predicate (queryCompilerMany.mts), and a link to a row the writer cannot read is
 * left alone: the writer never saw it, so the list they send says nothing about it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Field = { id?: string; key?: string; type?: string; relation?: { table?: string; many?: unknown } };
type Table = { id?: string; key?: string; fields?: Field[] };
type AccessFilter = { where: string; params: unknown[] };
type Target = { tableMeta: Table; accessFilter: AccessFilter };
type Statement = { sql: string; params: unknown[] };
type App = { id: string; userId: string };
export type Link = { field: Field; ids: string[] };

const many = nodeRequire('../../core/dataEngine/queryCompilerMany.mts') as typeof import('../../core/dataEngine/queryCompilerMany.mts');
const { relatedTablesFor } = nodeRequire('../../core/dataEngine/aggregateRelated.mts') as {
    relatedTablesFor(model: unknown, tableMeta: Table, keys: string[], who: { role: unknown; viewer: unknown; dialect?: string }): Record<string, Target>;
};
const { isManyRelation } = nodeRequire('../../core/dataEngine/dataModel/linkedFields') as { isManyRelation(f: unknown): boolean };
const { CompileError } = nodeRequire('../../core/dataEngine/queryCompilerCore') as { CompileError: new (message: string) => Error };
const { resolveDialect } = nodeRequire('../../core/dataEngine/engineFlag') as { resolveDialect(o: { dialect?: string }): string };
const dbStore = (): { query(owner: string, appId: string, sql: string, params: unknown[]): Promise<{ rows: Obj[] }> } => nodeRequire('../../stores/studioAppDbStore');

/** `values` without its many relations, and the id list of each one it carries. The same object when it carries none. */
export function splitLinks<V extends Obj>(table: Table, values: V): { values: V; links: Link[] } {
    const fields = (table && Array.isArray(table.fields) ? table.fields : []).filter((f) => isManyRelation(f));
    if (!fields.length || !values || typeof values !== 'object') return { values, links: [] };
    const links: Link[] = [];
    const rest: Obj = { ...values };
    for (const field of fields) {
        const key = field.key as string;
        if (!Object.hasOwn(rest, key)) continue;
        links.push({ field, ids: many.linkIdsOf(field, rest[key]) });
        delete rest[key];
    }
    return links.length ? { values: rest as V, links } : { values, links };
}

/**
 * The statements that replace the links of `recordId` (one record), after checking that every
 * listed id is a readable row of the related table.
 * @param viewer  the writer: `role` and the attributes the row rules read
 */
export async function linkStatements(app: App, model: unknown, table: Table, viewer: Obj, recordId: string, links: Link[]): Promise<Statement[]> {
    if (!links.length) return [];
    const dialect = resolveDialect({});
    const who = { role: viewer.role ?? null, viewer, dialect };
    const related = relatedTablesFor(model, table, links.map((l) => l.field.key as string), who);
    const out: Statement[] = [];
    for (const { field, ids } of links) {
        const target = Object.hasOwn(related, field.key as string) ? related[field.key as string] : null;
        if (!target) throw new CompileError(`field "${field.key}" does not point at a table of this app that keeps its own rows`);
        if (ids.length) {
            const { sql, params } = many.compileLinkTargetCount(target, ids, dialect);
            const { rows } = await dbStore().query(app.userId, app.id, sql, params);
            if (Number(rows[0] && rows[0].n) !== ids.length) throw new CompileError(`field "${field.key}" names a record that does not exist or that you cannot see`);
        }
        out.push(...many.compileLinkReplace(table, field, target, recordId, ids, dialect));
    }
    return out;
}
