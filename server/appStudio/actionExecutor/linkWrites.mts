/**
 * App Studio action executor: the links of a many relation (`relation.many: true`) on the
 * one-record writes of records.js (writeRecord, writeRecordBatch). The links are not a column:
 * they go to the relation's junction in the SAME transaction as the row itself.
 *
 *   writeRow(app, target, values, compile)        one create or update, its links in the same transaction
 *   insertsWithLinks(app, target, rows, compile)  N creates and their links, for one batch
 *   splitLinks / linkStatements                   the two halves both are built from
 *
 * The delete half (relation.onDelete) is cascadeDelete.mts, re-exported here so records.js has
 * one door onto both.
 *
 * Every id is viewer input. Before anything is written, each listed id must be a row of the
 * related table the writer may READ (one COUNT under that table's access predicate); an id that
 * is not is a 422 naming the field, never a link written in silence. The statements themselves
 * repeat the predicate (queryCompilerMany.mts), and a link to a row the writer cannot read is
 * left alone: the writer never saw it, so the list they send says nothing about it.
 */

import { createRequire } from 'node:module';
import { execWrite } from './recordWriteExec.mts';
import type { AppDb } from './recordWriteExec.mts';

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
const dbStore = (): {
    query(owner: string, appId: string, sql: string, params: unknown[]): Promise<{ rows: Obj[] }>;
    exec(owner: string, appId: string, sql: string, params: unknown[]): Promise<{ changes?: number } | null>;
    batch(owner: string, appId: string, statements: Array<Statement & { expectChanges?: boolean }>): Promise<unknown>;
} => nodeRequire('../../stores/studioAppDbStore');

export { hasDeleteRules, eraseWithRules, refusingLinks } from './cascadeDelete.mts';

/**
 * Who writes where: the model the relations resolve in, the table, the writer; `recordId` and
 * `update` for an update; `source` the write's origin (only a write that names one can start a
 * record trigger, recordWriteExec.mts).
 */
export type WriteTarget = { model: unknown; table: Table; viewer: Obj; recordId?: string; update?: boolean; source?: unknown };
type CompiledRow = Statement & { id?: string };

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
 * One row write with its links: `compile` builds the INSERT or UPDATE from the values without the
 * many relations. Without links it runs as it always did (one exec); with links, the row first and
 * then its links in ONE transaction, and an update must change its row (so a row outside the
 * writer's update rule changes no link either). Answers `{ id, changes }`.
 */
export async function writeRow(app: App, target: WriteTarget, values: Obj, compile: (values: Obj) => CompiledRow): Promise<{ id?: string; changes: number }> {
    const split = splitLinks(target.table, values);
    const c = compile(split.values);
    const recordId = (c.id ?? target.recordId) as string;
    const links = await linkStatements(app, target.model, target.table, target.viewer, recordId, split.links);
    const write = { event: target.update ? 'update' as const : 'create' as const, recordId, sql: c.sql, params: c.params, links };
    const changes = await execWrite(dbStore() as AppDb, app, target.table, write, { source: target.source, viewer: target.viewer });
    return { id: c.id, changes };
}

/** N creates and the links each carries: `compile` turns the rows without their many relations into INSERTs and ids. */
export async function insertsWithLinks(app: App, target: WriteTarget, rows: Obj[], compile: (rows: Obj[]) => { statements: Statement[]; ids: string[] }): Promise<{ statements: Statement[]; ids: string[] }> {
    const parts = rows.map((r) => splitLinks(target.table, r));
    const out = compile(parts.map((p) => p.values));
    for (const [i, p] of parts.entries()) {
        if (p.links.length) out.statements.push(...await linkStatements(app, target.model, target.table, target.viewer, out.ids[i], p.links));
    }
    return out;
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
