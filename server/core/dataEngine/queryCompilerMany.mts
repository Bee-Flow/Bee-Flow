/**
 * The SQL of a many relation (`relation.many: true`, dataModel/linkedFields.js): its links live
 * in a junction table (source_id, target_id) the data engine manages, and every statement here
 * reads or writes a link only through a target row the viewer may READ:
 *
 *   filter   { field: <many relation>, op: 'contains' | 'notContains', value: <record id> }
 *
 *              "id" [NOT] IN (SELECT "source_id" FROM <junction>
 *                             WHERE "target_id" = ? AND "target_id" IN (SELECT "id" FROM <target> WHERE (<target access>)))
 *
 *            so an id the viewer may not read matches what an id that does not exist matches.
 *   read     the links of a page of records, each to a readable target row
 *   write    replace the links of one record: the links to readable rows that are not in the
 *            new list go, the new ones come (only to rows that exist and are readable); a link
 *            to a row the writer may not read is left as it is, because the writer never saw it.
 *
 * The target table and the viewer's access predicate on it come from the caller (the related
 * tables of relationRead.mts / the write path), never from the request.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { id?: string; key?: string; type?: string; relation?: { table?: string; many?: unknown } };
type TableMeta = { id?: string; key?: string; fields?: Field[] };
type AccessFilter = { where: string; params: unknown[] };
type Target = { tableMeta: TableMeta; accessFilter: AccessFilter };
type Compiled = { sql: string; params: unknown[] };

const core = nodeRequire('./queryCompilerCore') as {
    CompileError: new (message: string) => Error;
    MAX_IN_VALUES: number;
    qi(name: string): string;
    scalar(v: unknown, dialect: string): string | number | boolean | null;
    assertTableMeta(tableMeta: TableMeta): void;
    assertAccessFilter(accessFilter: unknown): void;
};
const linked = nodeRequire('./dataModel/linkedFields') as {
    MANY_FILTER_OPS: readonly string[];
    JUNCTION_SOURCE: string;
    JUNCTION_TARGET: string;
    LINKED_FIELD_LIMITS: { MAX_MANY_LINKS: number };
    isManyRelation(f: unknown): boolean;
    junctionName(tableId: string, fieldId: string): string;
};

const { CompileError, qi } = core;
const SRC = qi(linked.JUNCTION_SOURCE);
const TGT = qi(linked.JUNCTION_TARGET);

/** The junction of a many relation of `tableMeta`; refuses a table or field without a stable id. */
export function junctionOf(tableMeta: TableMeta, field: Field): string {
    if (typeof tableMeta.id !== 'string' || !tableMeta.id || typeof field.id !== 'string' || !field.id) {
        throw new CompileError(`many relation "${field.key}" needs the stable ids of its table and field`);
    }
    return qi(linked.junctionName(tableMeta.id, field.id));
}

/** `"target_id" IN (SELECT "id" FROM <target> WHERE (<access>))`: only links to rows the viewer may read. */
function readableTarget(target: Target): Compiled {
    core.assertTableMeta(target.tableMeta);
    core.assertAccessFilter(target.accessFilter);
    return {
        sql: `${TGT} IN (SELECT ${qi('id')} FROM ${qi(target.tableMeta.key as string)} WHERE (${target.accessFilter.where}))`,
        params: [...target.accessFilter.params],
    };
}

/** A filter clause on a many relation, or null when the clause is about something else. */
export function manyFilterSql(
    tableMeta: TableMeta,
    field: Field | undefined,
    clause: Record<string, unknown>,
    target: Target | undefined,
    dialect: string,
): Compiled | null {
    if (!field || !linked.isManyRelation(field)) return null;
    if (!linked.MANY_FILTER_OPS.includes(clause.op as string)) {
        throw new CompileError(`a many relation ("${field.key}") is filtered with ${linked.MANY_FILTER_OPS.join(' or ')} and one record id, not ${clause.op}`);
    }
    if (clause.otherField !== undefined && clause.otherField !== null) throw new CompileError('a many relation compares with a record id, not with another column');
    if (typeof clause.value !== 'string' || !clause.value) throw new CompileError(`a ${clause.op} filter on "${field.key}" needs one record id`);
    if (!target) throw new CompileError(`a filter on "${field.key}" cannot read through it: it does not point at a table of this app that keeps its own rows`);
    const readable = readableTarget(target);
    const neg = clause.op === 'notContains' ? 'NOT ' : '';
    return {
        sql: `${qi('id')} ${neg}IN (SELECT ${SRC} FROM ${junctionOf(tableMeta, field)} WHERE ${TGT} = ? AND ${readable.sql})`,
        params: [core.scalar(clause.value, dialect), ...readable.params],
    };
}

/** The links of these records to readable target rows: rows `{ s, t }`. */
export function compileLinkRead(tableMeta: TableMeta, field: Field, target: Target, ids: unknown[], dialect: string): Compiled {
    const list = ids.filter((id) => typeof id === 'string' && id);
    if (!list.length) throw new CompileError('compileLinkRead requires at least one record id');
    if (list.length > core.MAX_IN_VALUES) throw new CompileError(`compileLinkRead accepts at most ${core.MAX_IN_VALUES} ids per call`);
    const readable = readableTarget(target);
    return {
        sql: `SELECT ${SRC} AS ${qi('s')}, ${TGT} AS ${qi('t')} FROM ${junctionOf(tableMeta, field)} `
            + `WHERE ${SRC} IN (${list.map(() => '?').join(', ')}) AND ${readable.sql} ORDER BY ${SRC}, ${TGT}`,
        params: [...list.map((id) => core.scalar(id, dialect)), ...readable.params],
    };
}

/**
 * The ids a write of a many relation carries: a list of distinct non-empty strings (null or an
 * empty list clears it), at most MAX_MANY_LINKS.
 */
export function linkIdsOf(field: Field, value: unknown): string[] {
    if (value === null || value === undefined) return [];
    const max = linked.LINKED_FIELD_LIMITS.MAX_MANY_LINKS;
    if (!Array.isArray(value)) throw new CompileError(`field "${field.key}" is a many relation: write a list of record ids`);
    if (value.length > max) throw new CompileError(`field "${field.key}" takes at most ${max} links`);
    const out: string[] = [];
    for (const id of value) {
        if (typeof id !== 'string' || !id || id.length > 64) throw new CompileError(`field "${field.key}" takes record ids (non-empty strings of at most 64 characters)`);
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

/** How many of `ids` are rows of the target the viewer may read: one row `{ n }`. */
export function compileLinkTargetCount(target: Target, ids: string[], dialect: string): Compiled {
    core.assertTableMeta(target.tableMeta);
    core.assertAccessFilter(target.accessFilter);
    return {
        sql: `SELECT COUNT(*) AS ${qi('n')} FROM ${qi(target.tableMeta.key as string)} WHERE (${target.accessFilter.where}) `
            + `AND ${qi('id')} IN (${ids.map(() => '?').join(', ')})`,
        params: [...target.accessFilter.params, ...ids.map((id) => core.scalar(id, dialect))],
    };
}

/**
 * Replace the links of one record (ids already through linkIdsOf): the DELETE of the readable
 * links that are not kept, then the INSERT of the new ones, each only to a readable row.
 */
export function compileLinkReplace(tableMeta: TableMeta, field: Field, target: Target, recordId: string, ids: string[], dialect: string): Compiled[] {
    const jn = junctionOf(tableMeta, field);
    const readable = readableTarget(target);
    const src = core.scalar(recordId, dialect);
    const keep = ids.length ? ` AND ${TGT} NOT IN (${ids.map(() => '?').join(', ')})` : '';
    const out: Compiled[] = [{
        sql: `DELETE FROM ${jn} WHERE ${SRC} = ? AND ${readable.sql}${keep}`,
        params: [src, ...readable.params, ...ids.map((id) => core.scalar(id, dialect))],
    }];
    if (ids.length) {
        out.push({
            sql: `INSERT INTO ${jn} (${SRC}, ${TGT}) SELECT ?, ${qi('id')} FROM ${qi(target.tableMeta.key as string)} `
                + `WHERE (${target.accessFilter.where}) AND ${qi('id')} IN (${ids.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
            params: [src, ...target.accessFilter.params, ...ids.map((id) => core.scalar(id, dialect))],
        });
    }
    return out;
}
