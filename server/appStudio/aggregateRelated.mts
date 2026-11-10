/**
 * The related tables an aggregate read needs when it groups through a relation
 * (`groupBy: [{ field: <relation>, relatedField }]`), each with the viewer's
 * access predicate on it, for queryCompiler.compileAggregate's `related`
 * argument.
 *
 * Every App Studio read path that compiles an aggregate over the app's own
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
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; relation?: { table?: string } };
type Table = { id?: string; key?: string; fields?: Field[]; source?: unknown };
type AccessFilter = { where: string; params: unknown[] };
type Related = Record<string, { tableMeta: Table; accessFilter: AccessFilter }>;

const rlsGateway = nodeRequire('./rlsGateway') as {
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

/**
 * @param model      the app's data model ({ tables })
 * @param tableMeta  the table the aggregate reads, as compiled
 * @param groupBy    the descriptor's groupBy
 * @param who        the role, viewer and dialect the main access filter was compiled with
 */
export function relatedForAggregate(
    model: { tables?: unknown } | null | undefined,
    tableMeta: Table,
    groupBy: unknown,
    who: { role: unknown; viewer: unknown; dialect?: string },
): Related | undefined {
    const keys = relationFieldsOf(groupBy);
    if (keys.length === 0) return undefined;
    const tables = (model && Array.isArray(model.tables) ? model.tables : []) as Table[];
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields as Field[] : [];
    const out: Related = {};
    for (const key of keys) {
        const field = fields.find((f) => f && f.key === key);
        const ref = field && field.type === 'relation' && field.relation ? field.relation.table : undefined;
        const target = typeof ref === 'string' ? tables.find((t) => t && (t.id === ref || t.key === ref)) : undefined;
        if (!target || (target.source !== undefined && target.source !== null)) continue;
        const accessFilter = rlsGateway.canRead(target, who.role)
            ? rlsGateway.compileAccessFilter(target, who.role, who.viewer, 'read', { dialect: who.dialect })
            : NO_ROWS;
        out[key] = { tableMeta: target, accessFilter };
    }
    return Object.keys(out).length ? out : undefined;
}
