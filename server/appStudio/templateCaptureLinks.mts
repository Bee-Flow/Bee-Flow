/**
 * Template capture: the links of the many relations (`relation.many: true`) of captured rows.
 *
 * A captured row is read from its table's columns, and a many relation has none: its links sit
 * in a junction. This fills each captured row's many-relation fields with the list of linked
 * record ids, read the way every record read fills them (core/dataEngine/linkedRead.mts): as the
 * owner, under the related table's row rules. buildSeed then keeps the links to rows the capture
 * carries, as `[{ $ref }]` (seedLinks.mts). A table without a many relation is not touched.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Table = { fields?: unknown; source?: unknown };

export async function fillManyLinks(model: unknown, table: Table, rows: Row[], who: { appId: string; userId: string }): Promise<void> {
    const { isManyRelation } = nodeRequire('../core/dataEngine/dataModel/linkedFields') as { isManyRelation: (f: unknown) => boolean };
    const fields = (Array.isArray(table.fields) ? table.fields : []) as Array<{ key?: string }>;
    const manyKeys = fields.filter((f) => isManyRelation(f)).map((f) => f.key as string);
    if (!manyKeys.length || !rows.length) return;
    const { linkedReadPlan, fillLinked } = nodeRequire('../core/dataEngine/linkedRead.mts') as typeof import('../core/dataEngine/linkedRead.mts');
    const plan = linkedReadPlan(model, table as never, { role: 'owner', viewer: { id: who.userId } }, manyKeys);
    if (!plan) return;
    const db = nodeRequire('../stores/studioAppDbStore') as { query: (owner: string, appId: string, sql: string, params: unknown[]) => Promise<{ rows?: Row[] }> };
    await fillLinked(plan, rows, (sql, params) => db.query(who.userId, who.appId, sql, params));
}
