/**
 * The related tables an aggregate read needs when it groups through a relation
 * (`groupBy: [{ field: <relation>, relatedField }]`), each with the viewer's
 * access predicate on it, for queryCompiler.compileAggregate's `related`
 * argument.
 *
 * Lives in core/ next to the access filter it compiles (the App Studio read
 * paths and the server render both call it). Every App Studio read path that compiles an aggregate over the app's own
 * storage calls this with the role and viewer it already compiled the main
 * table's access filter for, so the related table is read under the same
 * identity. The rules:
 *   - only a relation field of the aggregated table is followed, to the table
 *     its `relation.table` names in this model;
 *   - a role that may not read that table gets a predicate that matches no
 *     row (`1=0`): its orders still count, in the empty group, and nothing of
 *     the related table is read;
 *   - a target that keeps its rows outside the app's database (a linked Studio
 *     table) is not handed over: the compiler then refuses the entry.
 * Returns undefined when no groupBy entry goes through a relation, so a
 * descriptor without one is compiled exactly as before.
 *
 * The same rules serve a filter through a relation (`{ field:
 * '<relation>.<column>' }`, relationFilterFields) and the record reads that
 * expand a relation (relationRead.mts): one place decides which table a
 * relation may reach and under which predicate.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; relation?: { table?: string; many?: boolean } };
type Table = { id?: string; key?: string; fields?: Field[]; source?: unknown };
type AccessFilter = { where: string; params: unknown[] };
type Related = Record<string, { tableMeta: Table; accessFilter: AccessFilter }>;

const accessFilter = nodeRequire('./accessFilter') as {
    canRead(table: Table, role: unknown): boolean;
    compileAccessFilter(table: Table, role: unknown, viewer: unknown, action: string, opts?: { dialect?: string }): AccessFilter;
};

const NO_ROWS: AccessFilter = Object.freeze({ where: '1=0', params: [] }) as AccessFilter;

/** The relation fields a groupBy list goes through (each once). */
function relationFieldsOf(groupBy: unknown): string[] {
    if (!Array.isArray(groupBy)) return [];
    const out = new Set<string>();
    for (const g of groupBy) {
        if (g && typeof g === 'object' && typeof g.field === 'string' && g.relatedField !== undefined && g.relatedField !== null) out.add(g.field);
    }
    return [...out];
}

/** The relation fields a filter list reads through (`<relation>.<column>` clauses, inside groups too), each once. */
export function relationFilterFields(filters: unknown): string[] {
    const out = new Set<string>();
    const walk = (entry: unknown, depth: number): void => {
        if (!entry || typeof entry !== 'object' || depth > 8) return;
        if (Array.isArray(entry)) { for (const e of entry) walk(e, depth + 1); return; }
        const e = entry as Record<string, unknown>;
        if (typeof e.field === 'string') {
            const dot = e.field.indexOf('.');
            if (dot > 0) out.add(e.field.slice(0, dot));
            return;
        }
        walk(e.any, depth + 1);
        walk(e.all, depth + 1);
        walk(e.not, depth + 1);
    };
    walk(filters, 0);
    return [...out];
}

/**
 * The many relations of `tableMeta` a filter list names as a plain field (`{ field: <many
 * relation>, op: 'contains', value }`, inside groups too), each once: their junction is read
 * under the related table's access predicate (queryCompilerMany.mts).
 */
export function manyFilterFields(tableMeta: Table, filters: unknown): string[] {
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields as Field[] : [];
    const out = new Set<string>();
    const walk = (entry: unknown, depth: number): void => {
        if (!entry || typeof entry !== 'object' || depth > 8) return;
        if (Array.isArray(entry)) { for (const e of entry) walk(e, depth + 1); return; }
        const e = entry as Record<string, unknown>;
        if (typeof e.field === 'string') {
            const f = fields.find((x) => x && x.key === e.field);
            if (f && f.type === 'relation' && f.relation && f.relation.many === true) out.add(e.field);
            return;
        }
        walk(e.any, depth + 1);
        walk(e.all, depth + 1);
        walk(e.not, depth + 1);
    };
    walk(filters, 0);
    return [...out];
}

/**
 * @param model      the app's data model ({ tables })
 * @param tableMeta  the table the aggregate reads, as compiled
 * @param groupBy    the descriptor's groupBy
 * @param who        the role, viewer and dialect the main access filter was compiled with
 * @param filters    the descriptor's filters, for `<relation>.<column>` clauses
 */
export function relatedForAggregate(
    model: { tables?: unknown } | null | undefined,
    tableMeta: Table,
    groupBy: unknown,
    who: { role: unknown; viewer: unknown; dialect?: string },
    filters?: unknown,
): Related | undefined {
    const filterKeys = [...relationFilterFields(filters), ...manyFilterFields(tableMeta, filters)];
    const keys = [...new Set([...relationFieldsOf(groupBy), ...filterKeys])];
    if (keys.length === 0) return undefined;
    const out = relatedTablesFor(model, tableMeta, keys, who);
    // With a filter through a relation the map is handed over even when empty,
    // so the compiler refuses the clause by name instead of calling it an unknown field.
    return Object.keys(out).length || filterKeys.length ? out : undefined;
}

/**
 * The tables behind these relation fields of `tableMeta`, each with the
 * viewer's access predicate on it. A key that is not a relation to a table of
 * this model with its own storage is left out (the compiler then refuses it).
 */
export function relatedTablesFor(
    model: { tables?: unknown } | null | undefined,
    tableMeta: Table,
    keys: string[],
    who: { role: unknown; viewer: unknown; dialect?: string },
): Related {
    const tables = (model && Array.isArray(model.tables) ? model.tables : []) as Table[];
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields as Field[] : [];
    const out: Related = {};
    for (const key of keys) {
        const field = fields.find((f) => f && f.key === key);
        const ref = field && field.type === 'relation' && field.relation ? field.relation.table : undefined;
        const target = typeof ref === 'string' ? tables.find((t) => t && (t.id === ref || t.key === ref)) : undefined;
        if (!target || (target.source !== undefined && target.source !== null)) continue;
        const filter = accessFilter.canRead(target, who.role)
            ? accessFilter.compileAccessFilter(target, who.role, who.viewer, 'read', { dialect: who.dialect })
            : NO_ROWS;
        out[key] = { tableMeta: target, accessFilter: filter };
    }
    return out;
}
