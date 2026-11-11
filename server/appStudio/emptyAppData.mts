/**
 * Empty the rows of an app's own tables and keep the tables ("start clean").
 *
 * A relation column is `REFERENCES "<parent>"(id)` with no ON DELETE and the app database runs
 * with foreign keys on (see the header of connectorRetention.mts), so the tables go CHILD-FIRST:
 * a table that others point at is deleted after them. A self-reference is fine inside one DELETE
 * (SQLite checks a constraint at the end of the statement). Everything runs in ONE `batch`, so
 * the emptying is all or nothing.
 *
 * What is decided here, before any statement runs:
 *   - unknown table ids (400, `unknown_tables`);
 *   - tables with no storage of their own (a `source` block: datatable, mirror, spreadsheet) or
 *     with locked rows are SKIPPED and reported, never touched;
 *   - a chosen table that a table which is NOT being emptied points at is refused (409
 *     `referenced_by`, the selection is never widened silently);
 *   - the order, by Kahn's algorithm over the relation columns. Tables left over form cycles
 *     between different tables: their relation columns inside the cycle are nulled first (same
 *     transaction), but only when none of them is `required` (otherwise 409 `relation_cycle`).
 *
 * After the commit: the blobs behind the deleted files (refcounted, purgeAttachments), the cached
 * row count (0) and the data version of every emptied table, and the sync state of every connector
 * that fills one of them, so its next run refills from the lookback window as a first run.
 */

import { createRequire } from 'node:module';
import { fileIdsFromRows, collectFileIds } from './connectorRetention.mts';

const nodeRequire = createRequire(import.meta.url);

type Field = { key: string; type?: string; required?: boolean; relation?: { table?: string } | null };
type Table = { id?: string; key: string; fields?: Field[]; source?: unknown; rowsLocked?: boolean };
type Connector = { id: string; sync?: { tableId?: string; children?: Array<{ tableId?: string }> } | null };
type Model = { tables?: Table[]; connectors?: Connector[] };
type Row = Record<string, unknown>;
type BatchResult = { rows?: Row[]; changes?: number };
type Stmt = { sql: string; params: unknown[] };
type Access = { where: string; params: unknown[] };
type App = { id: string; userId: string };

export type EmptyDeps = {
    batch: (ownerId: string, appId: string, statements: Stmt[]) => Promise<BatchResult[]>;
    /** Paged reads of the file columns before the transaction (see collectFileIds). */
    query?: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<{ rows?: Row[] }>;
    compileDeleteAll: (t: Table, a: Access) => Stmt;
    purgeAttachments: (fileIds: string[]) => Promise<void>;
    setRowCount: (appId: string, tableKey: string, count: number, ownerId: string) => Promise<unknown>;
    bumpDataVersion: (appId: string, tableKey: string, ownerId: string) => Promise<unknown>;
    resetSyncStates: (appId: string, ownerId: string, connectorIds: string[]) => Promise<number>;
};

export type EmptyResult = {
    emptied: Array<{ tableId: string; key: string; rows: number }>;
    skipped: Array<{ tableId: string; key: string; reason: string }>;
    connectorsReset: number;
    files: number;
};

export type EmptyRefusal =
    | { status: 400; code: 'unknown_tables'; error: string; tableIds: string[] }
    | { status: 400; code: 'too_many_tables'; error: string }
    | { status: 409; code: 'referenced_by'; error: string; tables: Array<{ tableId: string; key: string; referencedBy: string[] }> }
    | { status: 409; code: 'relation_cycle'; error: string; tables: Array<{ tableId: string; key: string; referencedBy: string[] }> };

type Plan = { ordered: Table[]; skipped: EmptyResult['skipped']; nullings: Array<{ table: Table; field: string }> };

// Emptying runs as the owner: every row and every column of any table, also of a table whose
// fields carry column rights (a compiler that scopes columns refuses an access without that verdict).
const { OWNER_ACCESS: OWNER_FILTER } = nodeRequire('./queryCompiler') as { OWNER_ACCESS: Access };
const MAX_BATCH = 500;
const qi = (name: string) => '"' + String(name).replace(/"/g, '""') + '"';
const idOf = (t: Table) => t.id || t.key;

/** Why a table cannot be emptied here, or null. */
function skipReason(t: Table): string | null {
    if (t.source) return 'external_source';
    if (t.rowsLocked === true) return 'rows_locked';
    return null;
}

/** The relation columns of `t` that point at another table of `inSet` (self-references left out). */
function relationsTo(t: Table, inSet: Set<string>): Array<{ field: Field; parent: string }> {
    const out: Array<{ field: Field; parent: string }> = [];
    for (const f of t.fields || []) {
        const target = f && f.type === 'relation' ? f.relation?.table : undefined;
        if (target && target !== t.id && inSet.has(target)) out.push({ field: f, parent: target });
    }
    return out;
}

/** Child-first order of `tables`; whatever cannot be placed (a cycle) is returned in `stuck`. */
function orderChildFirst(tables: Table[], ignore: Set<string>): { ordered: Table[]; stuck: Table[] } {
    const inSet = new Set(tables.map(idOf));
    // children[p] = tables that point at p (they must go before p)
    const remaining = new Map<string, number>(); // parent id -> children not yet placed
    const childrenOf = new Map<string, string[]>();
    for (const t of tables) remaining.set(idOf(t), 0);
    for (const t of tables) {
        for (const { field, parent } of relationsTo(t, inSet)) {
            if (ignore.has(`${idOf(t)}.${field.key}`)) continue;
            remaining.set(parent, (remaining.get(parent) || 0) + 1);
            childrenOf.set(idOf(t), [...(childrenOf.get(idOf(t)) || []), parent]);
        }
    }
    const byId = new Map(tables.map((t) => [idOf(t), t]));
    const queue = tables.filter((t) => remaining.get(idOf(t)) === 0).map(idOf);
    const ordered: Table[] = [];
    while (queue.length) {
        const id = queue.shift() as string;
        ordered.push(byId.get(id) as Table);
        for (const parent of childrenOf.get(id) || []) {
            remaining.set(parent, (remaining.get(parent) || 0) - 1);
            if (remaining.get(parent) === 0) queue.push(parent);
        }
    }
    const placed = new Set(ordered.map(idOf));
    return { ordered, stuck: tables.filter((t) => !placed.has(idOf(t))) };
}

/** Decide what happens to which table, in which order. Pure: no statement runs here. */
export function planEmpty(model: Model, tableIds?: string[]): Plan | EmptyRefusal {
    const all = (model?.tables || []).filter((t) => t && t.key);
    const wanted = Array.isArray(tableIds) && tableIds.length ? [...new Set(tableIds)] : null;
    const known = new Set(all.map(idOf));
    const unknown = wanted ? wanted.filter((id) => !known.has(id)) : [];
    if (unknown.length) return { status: 400, code: 'unknown_tables', error: `Unknown table id(s): ${unknown.join(', ')}`, tableIds: unknown };

    const chosen = wanted ? all.filter((t) => wanted.includes(idOf(t))) : all;
    const skipped: Plan['skipped'] = [];
    const doing: Table[] = [];
    for (const t of chosen) {
        const reason = skipReason(t);
        if (reason) skipped.push({ tableId: idOf(t), key: t.key, reason });
        else doing.push(t);
    }
    const doingIds = new Set(doing.map(idOf));

    // A table that is not emptied but still points at a chosen one would make the DELETE fail.
    // Tables with a `source` have no rows in the app database, so they cannot hold such a reference.
    const refused: Array<{ tableId: string; key: string; referencedBy: string[] }> = [];
    for (const t of doing) {
        const by = all
            .filter((r) => !doingIds.has(idOf(r)) && !r.source && r !== t)
            .filter((r) => (r.fields || []).some((f) => f && f.type === 'relation' && f.relation?.table === t.id))
            .map((r) => r.key);
        if (by.length) refused.push({ tableId: idOf(t), key: t.key, referencedBy: by });
    }
    if (refused.length) {
        return { status: 409, code: 'referenced_by', error: 'Another table still points at a table you chose; empty that table too.', tables: refused };
    }

    let { ordered, stuck } = orderChildFirst(doing, new Set());
    const nullings: Plan['nullings'] = [];
    if (stuck.length) {
        // A cycle between different tables: break it by nulling the relation columns inside it.
        const stuckIds = new Set(stuck.map(idOf));
        // Tables that merely wait on a cycle (they point at nothing inside it) are no part of it.
        for (let peeled = true; peeled;) {
            peeled = false;
            for (const t of stuck) {
                if (stuckIds.has(idOf(t)) && !relationsTo(t, stuckIds).length) { stuckIds.delete(idOf(t)); peeled = true; }
            }
        }
        const ignore = new Set<string>();
        const blocked: Array<{ tableId: string; key: string; referencedBy: string[] }> = [];
        for (const t of stuck.filter((x) => stuckIds.has(idOf(x)))) {
            for (const { field, parent } of relationsTo(t, stuckIds)) {
                if (field.required) {
                    blocked.push({ tableId: idOf(t), key: t.key, referencedBy: [`${t.key}.${field.key} -> ${parent}`] });
                    continue;
                }
                nullings.push({ table: t, field: field.key });
                ignore.add(`${idOf(t)}.${field.key}`);
            }
        }
        if (blocked.length) {
            return { status: 409, code: 'relation_cycle', error: 'These tables point at each other through a required column, so they cannot be emptied.', tables: blocked };
        }
        ({ ordered, stuck } = orderChildFirst(doing, ignore));
        if (stuck.length) {
            return { status: 409, code: 'relation_cycle', error: 'These tables point at each other and cannot be ordered.', tables: stuck.map((t) => ({ tableId: idOf(t), key: t.key, referencedBy: [] })) };
        }
    }
    return { ordered, skipped, nullings };
}

type Meta = { kind: 'null' } | { kind: 'files'; table: Table; fileFields: Field[] } | { kind: 'delete'; table: Table };

function buildStatements(plan: Plan, deps: EmptyDeps): { stmts: Stmt[]; meta: Meta[] } {
    const stmts: Stmt[] = [];
    const meta: Meta[] = [];
    for (const { table, field } of plan.nullings) {
        stmts.push({ sql: `UPDATE ${qi(table.key)} SET ${qi(field)} = NULL WHERE ${OWNER_FILTER.where}`, params: [...OWNER_FILTER.params] });
        meta.push({ kind: 'null' });
    }
    for (const table of plan.ordered) {
        const fileFields = (table.fields || []).filter((f) => f && f.type === 'file');
        if (fileFields.length) {
            // The blobs behind the rows have to be collected before the rows are gone.
            const cols = fileFields.map((f) => qi(f.key)).join(', ');
            const some = fileFields.map((f) => `${qi(f.key)} IS NOT NULL`).join(' OR ');
            stmts.push({ sql: `SELECT ${cols} FROM ${qi(table.key)} WHERE ${OWNER_FILTER.where} AND (${some})`, params: [...OWNER_FILTER.params] });
            meta.push({ kind: 'files', table, fileFields });
        }
        const del = deps.compileDeleteAll(table, OWNER_FILTER);
        stmts.push({ sql: del.sql, params: del.params });
        meta.push({ kind: 'delete', table });
    }
    return { stmts, meta };
}

/** Ids of the connectors whose sync fills one of these tables (as main table or as a child). */
export function connectorsFilling(model: Model, tableIds: Set<string>): string[] {
    const out: string[] = [];
    for (const c of model?.connectors || []) {
        const s = c?.sync;
        if (!c?.id || !s) continue;
        const targets = [s.tableId, ...(Array.isArray(s.children) ? s.children.map((ch) => ch?.tableId) : [])];
        if (targets.some((id) => typeof id === 'string' && tableIds.has(id))) out.push(c.id);
    }
    return out;
}

/** Plan, run in one transaction, then clean up after the commit. Returns the result or a refusal. */
export async function emptyAppData(app: App, model: Model, tableIds: string[] | undefined, deps: EmptyDeps): Promise<EmptyResult | EmptyRefusal> {
    const plan = planEmpty(model, tableIds);
    if ('status' in plan) return plan;

    const emptied: EmptyResult['emptied'] = [];
    // The in-batch file SELECT is capped (the engines return at most 10 000 rows), so a bigger
    // table's files are read page by page first; the batch SELECT then only adds rows written
    // in between. A file missed here would stay in storage after its row is gone.
    const fileIds: string[] = deps.query ? await collectFileIds(app, plan.ordered, deps.query) : [];
    if (plan.ordered.length) {
        const { stmts, meta } = buildStatements(plan, deps);
        if (stmts.length > MAX_BATCH) {
            return { status: 400, code: 'too_many_tables', error: 'Too many tables to empty at once; choose fewer.' };
        }
        const results = await deps.batch(app.userId, app.id, stmts);
        meta.forEach((m, i) => {
            const res = results?.[i] || {};
            if (m.kind === 'files') fileIds.push(...fileIdsFromRows(m.fileFields, res.rows));
            else if (m.kind === 'delete') emptied.push({ tableId: idOf(m.table), key: m.table.key, rows: res.changes || 0 });
        });
    }

    // After the commit. The rows are gone, so a failure here must not turn the answer into an
    // error: the leftovers (blobs, a stale counter) are logged and the next recount heals them.
    const log = nodeRequire('../telemetry/log') as { warn: (m: string) => void; info: (m: string) => void };
    const uniqueFiles = [...new Set(fileIds)];
    if (uniqueFiles.length) {
        try { await deps.purgeAttachments(uniqueFiles); } catch (e) { log.warn(`[AppData] emptying ${app.id}: file purge failed: ${(e as Error).message}`); }
    }
    for (const t of plan.ordered) {
        try {
            await deps.setRowCount(app.id, t.key, 0, app.userId);
            await deps.bumpDataVersion(app.id, t.key, app.userId);
        } catch (e) { log.warn(`[AppData] emptying ${app.id}/${t.key}: counters not updated: ${(e as Error).message}`); }
    }
    let connectorsReset = 0;
    const connectorIds = connectorsFilling(model, new Set(plan.ordered.map(idOf)));
    if (connectorIds.length) {
        try { connectorsReset = await deps.resetSyncStates(app.id, app.userId, connectorIds); } catch (e) {
            log.warn(`[AppData] emptying ${app.id}: connector sync state not reset: ${(e as Error).message}`);
        }
    }
    log.info(`[AppData] app ${app.id} emptied: ${emptied.map((e) => `${e.key}=${e.rows}`).join(', ') || 'nothing'}`);
    return { emptied, skipped: plan.skipped, connectorsReset, files: uniqueFiles.length };
}
