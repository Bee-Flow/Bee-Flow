/**
 * App Studio action executor: deleting a record that other records point at through a relation
 * with `relation.onDelete` (core/dataEngine/dataModel/linkedFields.js). A relation without one
 * keeps today's behaviour: the database's foreign key decides, and this module is not involved.
 *
 *   restrict   the delete is refused (422 record_has_links) while any row points at the record
 *   setNull    the relation of every row pointing at it is emptied
 *   cascade    every row pointing at it is deleted too, and the rules of THAT table apply to it
 *
 * The rules of the person deleting hold for every row the rules touch: the role must be allowed
 * to update (setNull) or delete (cascade) the child table, and every child row must be inside
 * that role's update / delete row rule. One child outside it refuses the whole delete (403
 * cascade_forbidden): nothing is half-deleted, and no row the person may not change is changed.
 * The walk is bounded: at most STUDIO_APP_CASCADE_MAX_ROWS rows (default 500, 0 = no limit) and
 * MAX_CASCADE_DEPTH relations deep, both refused before anything is written (422).
 *
 * Everything is written in ONE transaction (studioAppDbStore.batch): the setNull updates, then
 * the deletes from the deepest table up. Each delete carries `NOT EXISTS` for every rule onto its
 * table, and the record itself must change one row, so a child written between the walk and the
 * commit makes the whole batch roll back (422 record_changed) instead of leaving it dangling.
 *
 * The filter-scoped deletes (bulk delete_record, a transaction child, replace) do not walk:
 * assertNoDeleteRules refuses them on a table such a rule points at.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Field = { key?: string; type?: string; relation?: { table?: string; many?: unknown; onDelete?: unknown } };
type Table = { id?: string; key?: string; name?: string; fields?: Field[]; source?: unknown };
type Statement = { sql: string; params: unknown[]; expectChanges?: boolean };
type App = { id: string; userId: string; organizationId?: string | null };
type Rule = { child: Table; fk: string; rule: 'restrict' | 'setNull' | 'cascade' };
type Work = { table: Table; ids: string[] };
type Walk = { app: App; model: unknown; role: unknown; viewer: Obj; max: number; total: number; updates: Statement[]; updated: Set<string>; deletes: Work[]; seen: Map<string, Set<string>> };

const linked = nodeRequire('../../core/dataEngine/dataModel/linkedFields') as {
    onDeleteOf(f: unknown): 'restrict' | 'setNull' | 'cascade' | null;
    cascadeMaxRows(): number;
    MAX_CASCADE_DEPTH: number;
};
const rls = nodeRequire('../rlsGateway') as {
    assertCanWrite(table: Table, role: unknown, action: string): unknown;
    compileAccessFilter(table: Table, role: unknown, viewer: unknown, action: string): { where: string; params: unknown[] };
};
const { qi } = nodeRequire('../../core/dataEngine/queryCompilerCore') as { qi(name: string): string };
const { HttpError } = nodeRequire('../../core/http/errors') as { HttpError: new (status: number, code: string, message: string) => Error };
const { bumpVersion, bumpCount } = nodeRequire('./bookkeeping.mts') as {
    bumpVersion(app: App, key: string): Promise<void>;
    bumpCount(app: App, key: string, delta: number): Promise<void>;
};
const store = (): {
    query(owner: string, appId: string, sql: string, params: unknown[]): Promise<{ rows: Obj[] }>;
    batch(owner: string, appId: string, statements: Statement[]): Promise<Array<{ changes?: number }>>;
} => nodeRequire('../../stores/studioAppDbStore');

/** Ids bound per statement. */
const CHUNK = 200;

const tablesOf = (model: unknown): Table[] => (model && typeof model === 'object' && Array.isArray((model as Obj).tables) ? (model as { tables: Table[] }).tables : []);
const ownStorage = (t: Table | undefined): boolean => !!t && (t.source === undefined || t.source === null);
const label = (t: Table): string => t.name || t.key || 'a table';

/** Every relation with an onDelete rule that points at `table`, on a table with its own storage. */
export function rulesOnto(model: unknown, table: Table): Rule[] {
    const out: Rule[] = [];
    for (const child of tablesOf(model)) {
        if (!ownStorage(child)) continue;
        for (const f of Array.isArray(child.fields) ? child.fields : []) {
            const rule = linked.onDeleteOf(f);
            const ref = f.relation && f.relation.table;
            if (rule && typeof f.key === 'string' && (ref === table.id || ref === table.key)) out.push({ child, fk: f.key, rule });
        }
    }
    return out;
}

/** Does deleting a record of `table` walk delete rules? */
export function hasDeleteRules(model: unknown, table: Table): boolean {
    return ownStorage(table) && rulesOnto(model, table).length > 0;
}

/** The filter-scoped deletes refuse a table a delete rule points at (they do not walk). */
export function assertNoDeleteRules(model: unknown, table: Table): void {
    if (!hasDeleteRules(model, table)) return;
    throw new HttpError(422, 'delete_rules', `Records of "${label(table)}" have linked records that follow a delete rule. Delete them one at a time.`);
}

const chunks = (ids: string[]): string[][] => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
const holes = (ids: string[]): string => ids.map(() => '?').join(', ');

async function idsWhere(w: Walk, table: Table, column: string, ids: string[], access: { where: string; params: unknown[] } | null): Promise<string[]> {
    const out: string[] = [];
    for (const part of chunks(ids)) {
        const scoped = access ? ` AND (${access.where})` : '';
        const sql = `SELECT ${qi('id')} AS ${qi('id')} FROM ${qi(table.key as string)} WHERE ${qi(column)} IN (${holes(part)})${scoped}`;
        const { rows } = await store().query(w.app.userId, w.app.id, sql, [...part, ...(access ? access.params : [])]);
        for (const r of rows) out.push(String(r.id));
    }
    return out;
}

function notSeen(w: Walk, table: Table, ids: string[]): string[] {
    const key = String(table.id || table.key);
    const seen = w.seen.get(key) || new Set<string>();
    w.seen.set(key, seen);
    const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    return fresh;
}

/** The child rows of one rule: refused, counted and checked against the deleting role, or nothing to do. */
async function childrenOf(w: Walk, rule: Rule, ids: string[]): Promise<string[]> {
    const kids = notSeen(w, rule.child, await idsWhere(w, rule.child, rule.fk, ids, null));
    if (!kids.length) return kids;
    if (rule.rule === 'restrict') {
        throw new HttpError(422, 'record_has_links', `This record cannot be deleted while records in "${label(rule.child)}" point at it.`);
    }
    w.total += kids.length;
    if (w.total > w.max) throw new HttpError(422, 'cascade_too_large', `Deleting this record would change more than ${w.max} linked records.`);
    const action = rule.rule === 'setNull' ? 'update' : 'delete';
    rls.assertCanWrite(rule.child, w.role, action);
    const allowed = await idsWhere(w, rule.child, 'id', kids, rls.compileAccessFilter(rule.child, w.role, w.viewer, action));
    if (allowed.length !== kids.length) {
        throw new HttpError(403, 'cascade_forbidden', `This record has linked records in "${label(rule.child)}" you may not ${action === 'update' ? 'change' : 'delete'}.`);
    }
    return kids;
}

function setNullStatements(w: Walk, rule: Rule, ids: string[]): Statement[] {
    const access = rls.compileAccessFilter(rule.child, w.role, w.viewer, 'update');
    const now = new Date().toISOString();
    return chunks(ids).map((part) => ({
        sql: `UPDATE ${qi(rule.child.key as string)} SET ${qi(rule.fk)} = NULL, ${qi('updated_at')} = ? WHERE ${qi('id')} IN (${holes(part)}) AND (${access.where})`,
        params: [now, ...part, ...access.params],
    }));
}

/** Follow every rule onto `work.table`, depth first; the deepest deletes are listed first. */
async function walk(w: Walk, work: Work, depth: number): Promise<void> {
    for (const rule of rulesOnto(w.model, work.table)) {
        const kids = await childrenOf(w, rule, work.ids);
        if (!kids.length) continue;
        if (rule.rule === 'setNull') { w.updates.push(...setNullStatements(w, rule, kids)); w.updated.add(rule.child.key as string); continue; }
        if (depth + 1 > linked.MAX_CASCADE_DEPTH) throw new HttpError(422, 'cascade_too_deep', `Deleting this record would follow more than ${linked.MAX_CASCADE_DEPTH} relations.`);
        await walk(w, { table: rule.child, ids: kids }, depth + 1);
        w.deletes.push({ table: rule.child, ids: kids });
    }
}

/** The DELETE of a batch of rows, guarded: no row a rule protects may still point at them. */
function deleteStatements(w: Walk, work: Work, root: boolean): Statement[] {
    const access = rls.compileAccessFilter(work.table, w.role, w.viewer, 'delete');
    const self = qi(work.table.key as string);
    const guards = rulesOnto(w.model, work.table)
        .map((r) => ` AND NOT EXISTS (SELECT 1 FROM ${qi(r.child.key as string)} AS ${qi('_c')} WHERE ${qi('_c')}.${qi(r.fk)} = ${self}.${qi('id')})`)
        .join('');
    return chunks(work.ids).map((part) => ({
        sql: `DELETE FROM ${self} WHERE ${qi('id')} IN (${holes(part)}) AND (${access.where})${guards}`,
        params: [...part, ...access.params],
        ...(root ? { expectChanges: true } : {}),
    }));
}

/** Data versions and row counts of every table the delete changed (best-effort, after the commit). */
async function bookkeep(w: Walk, plan: Statement[][], results: Array<{ changes?: number }>): Promise<void> {
    const removed = new Map<string, number>();
    let at = 0;
    for (const [i, work] of w.deletes.entries()) {
        const key = work.table.key as string;
        for (let n = 0; n < plan[i].length; n += 1, at += 1) removed.set(key, (removed.get(key) || 0) + (Number(results[at] && results[at].changes) || 0));
    }
    for (const key of new Set([...removed.keys(), ...w.updated])) await bumpVersion(w.app, key);
    for (const [key, n] of removed) if (n) await bumpCount(w.app, key, 0 - n);
}

/**
 * Delete one record of `table` and walk the delete rules onto it. Returns `{ changes }` of the
 * record itself: 0 when it is missing or outside the viewer's delete rule (one uniform answer).
 */
export async function eraseWithRules(app: App, model: unknown, table: Table, recordId: string, viewer: Obj): Promise<{ changes: number }> {
    const role = viewer.role ?? null;
    rls.assertCanWrite(table, role, 'delete');
    const w: Walk = { app, model, role, viewer, max: linked.cascadeMaxRows(), total: 0, updates: [], updated: new Set(), deletes: [], seen: new Map() };
    const own = await idsWhere(w, table, 'id', [recordId], rls.compileAccessFilter(table, role, viewer, 'delete'));
    if (!own.length) return { changes: 0 };
    notSeen(w, table, own);
    await walk(w, { table, ids: own }, 0);
    w.deletes.push({ table, ids: own });
    const plan = w.deletes.map((work, i) => deleteStatements(w, work, i === w.deletes.length - 1));
    let results: Array<{ changes?: number }>;
    try {
        results = await store().batch(app.userId, app.id, [...w.updates, ...plan.flat()]);
    } catch (e) {
        if (e && (e as Obj).code === 'batch_no_rows') throw new HttpError(422, 'record_changed', 'Records linked to this one changed while it was being deleted. Try again.');
        throw e;
    }
    await bookkeep(w, plan, results.slice(w.updates.length));
    const rootChanges = Number(results[results.length - 1] && results[results.length - 1].changes) || 0;
    return { changes: rootChanges };
}
