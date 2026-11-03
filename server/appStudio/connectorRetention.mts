/**
 * The retention purge of a connector, CHILD-FIRST and in one transaction.
 *
 * Why not parent-first: a relation column is created `REFERENCES "<parent>"(id)` with no ON
 * DELETE, and the app database runs with foreign keys on. Deleting a conversation that still has
 * messages (or a message that still has attachments) fails with "FOREIGN KEY constraint failed",
 * so in thread mode the old parent-first purge deleted nothing: a retention promise not kept.
 *
 * How it works (planRetention gives the steps, ordered parent-first by level):
 *   1. TOP-DOWN, each step gets its "doomed" predicate: a 'column' step is its own older-than
 *      test, a 'cascade' step is "my relation points at a doomed row of my parent, or my parent
 *      is gone" with the parent's predicate nested inside, however deep the plan is.
 *   2. BOTTOM-UP, each step deletes its doomed rows EXCEPT those something still points at: for
 *      every relation column in the whole model that targets the table, `id NOT IN (SELECT col
 *      ...)`. Children deleted earlier in the same transaction no longer block their parent;
 *      references that stay (an app-owned table pointing at a message) keep their target and
 *      so, in turn, its conversation. Such rows are counted and logged, never an error.
 *   3. Every SELECT (file columns, kept count) and DELETE of the run goes through one
 *      `batch`, so the purge is all or nothing. The blobs and ledger rows behind the deleted
 *      files go after the commit (refcounted, see purgeAttachments in connectorSync.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key: string; type?: string; relation?: { table?: string } | null };
type Table = { id?: string; key: string; fields?: Field[] };
type Model = { tables?: Table[] };
type Where = { where: string; params: unknown[] };
type Step = { level: number; table: Table; mode: 'column' | 'cascade'; column?: string; relationField?: string; parentTable?: Table; sweepNull?: boolean };
type Referrer = { tableMeta: Table; field: string };
type Row = Record<string, unknown>;
type BatchResult = { rows?: Row[]; changes?: number };
type Stmt = { sql: string; params: unknown[] };
type Access = { where: string; params: unknown[] };
type Deleted = { where: string; whereParams: unknown[] };
type RetentionDelete = Deleted & { sql: string; params: unknown[]; keptSql: string | null; keptParams: unknown[] };
type Log = { info: (m: string) => void; warn: (m: string) => void };

export type RetentionDeps = {
    compileDeleteOlderThan: (t: Table, a: Access, o: { field: string; cutoffIso: string }) => Deleted;
    compileDoomedUnderParent: (t: Table, a: Access, o: { relationField: string; parentTableMeta: Table; parentDoomed?: Where; sweepNull?: boolean }) => Where;
    compileRetentionDelete: (t: Table, a: Access, o: { doomed: Where; referrers: Referrer[] }) => RetentionDelete;
    batch: (ownerId: string, appId: string, statements: Stmt[]) => Promise<BatchResult[]>;
};

type App = { id: string; userId: string };
type Planned = { step: Step; doomed: Where };
type Meta =
    | { kind: 'files'; step: Step; fileFields: Field[] }
    | { kind: 'kept'; step: Step; referrers: Referrer[] }
    | { kind: 'delete'; step: Step };

const log = nodeRequire('../telemetry/log') as Log;
const { OWNER_FILTER } = nodeRequire('./connectorSyncKeys') as { OWNER_FILTER: Access };

const FILE_ROWS_LIMIT = 5000;
const MAX_BATCH = 500;

/**
 * The studio-attachment ids stored in the file columns of `rows`. Rows written while descriptors
 * were double-encoded parse to a STRING first (bounded unwrap): skipping them would delete the
 * row but keep the blob and its ledger entry. A pending mailbox descriptor points at the
 * provider and leaves nothing of ours behind.
 */
export function fileIdsFromRows(fileFields: Array<{ key: string }>, rows: Row[] | undefined): string[] {
    const ids: string[] = [];
    for (const row of rows || []) {
        for (const f of fileFields) {
            const raw = row[f.key];
            if (!raw) continue;
            let parsed: unknown = raw;
            for (let i = 0; i < 3 && typeof parsed === 'string'; i++) {
                try { parsed = JSON.parse(parsed); } catch { parsed = null; break; }
            }
            if (!parsed || typeof parsed !== 'object') continue;
            for (const d of (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ kind?: string; fileId?: string } | null>) {
                if (d && d.kind === 'studio_attachment' && d.fileId) ids.push(d.fileId);
            }
        }
    }
    return ids;
}

/** Every relation column in the model that targets this table, whichever table holds it. */
export function referrersOf(model: Model, table: Table): Referrer[] {
    const out: Referrer[] = [];
    for (const t of model?.tables || []) {
        for (const f of t?.fields || []) {
            if (f && f.type === 'relation' && f.relation && f.relation.table === table.id) out.push({ tableMeta: t, field: f.key });
        }
    }
    return out;
}

/** Top-down: the doomed predicate of every step. A step that cannot be compiled is warned about and left out. */
function planDoomed(steps: Step[], cutoffIso: string, deps: RetentionDeps, where: string): Planned[] {
    const doomedByTable = new Map<string | undefined, Where>();
    const planned: Planned[] = [];
    for (const step of steps) {
        try {
            let doomed: Where;
            if (step.mode === 'cascade') {
                doomed = deps.compileDoomedUnderParent(step.table, OWNER_FILTER, {
                    relationField: step.relationField as string,
                    parentTableMeta: step.parentTable as Table,
                    parentDoomed: doomedByTable.get(step.parentTable?.id),
                    sweepNull: step.sweepNull,
                });
            } else {
                const del = deps.compileDeleteOlderThan(step.table, OWNER_FILTER, { field: step.column as string, cutoffIso });
                doomed = { where: del.where, params: del.whereParams };
            }
            doomedByTable.set(step.table.id, doomed);
            planned.push({ step, doomed });
        } catch (e) {
            log.warn(`[ConnectorSync] retention purge failed on ${where} (${step.table.key}): ${(e as Error).message}`);
        }
    }
    return planned;
}

/** Bottom-up statements: per step [file SELECT], [kept-count SELECT], DELETE. */
function buildStatements(planned: Planned[], model: Model, deps: RetentionDeps, where: string): { stmts: Stmt[]; meta: Meta[] } {
    const stmts: Stmt[] = [];
    const meta: Meta[] = [];
    for (const { step, doomed } of [...planned].reverse()) {
        try {
            const referrers = referrersOf(model, step.table);
            const rd = deps.compileRetentionDelete(step.table, OWNER_FILTER, { doomed, referrers });
            const fileFields = (step.table.fields || []).filter((f) => f && f.type === 'file');
            // The WHERE comes straight off the compiled DELETE, so this selects exactly the rows
            // that are about to go (the blobs they point at have to be collected first).
            if (fileFields.length) {
                const cols = fileFields.map((f) => `"${f.key}"`).join(', ');
                stmts.push({ sql: `SELECT ${cols} FROM "${step.table.key}" WHERE ${rd.where} LIMIT ${FILE_ROWS_LIMIT}`, params: rd.whereParams });
                meta.push({ kind: 'files', step, fileFields });
            }
            if (rd.keptSql) {
                stmts.push({ sql: rd.keptSql, params: rd.keptParams });
                meta.push({ kind: 'kept', step, referrers });
            }
            stmts.push({ sql: rd.sql, params: rd.params });
            meta.push({ kind: 'delete', step });
        } catch (e) {
            log.warn(`[ConnectorSync] retention purge failed on ${where} (${step.table.key}): ${(e as Error).message}`);
        }
    }
    return { stmts, meta };
}

function logKept(counts: Map<string, { n: number; by: string[] }>, where: string) {
    for (const [table, { n, by }] of counts) {
        log.warn(`[ConnectorSync] retention on ${where}: kept ${n} row(s) of ${table} past the window: still referenced by ${by.join(', ')}`);
    }
}

/**
 * Run the retention plan child-first. Returns how many rows it deleted; never throws (the sync that
 * just succeeded must not fail because the purge did).
 */
export async function runRetention(opts: {
    app: App; model: Model; connectorId: string; steps: Step[]; cutoffIso: string; deps: RetentionDeps;
    purgeAttachments: (fileIds: string[]) => Promise<void>;
}): Promise<number> {
    const { app, model, steps, cutoffIso, deps } = opts;
    const where = `${app.id}/${opts.connectorId}`;
    const { stmts, meta } = buildStatements(planDoomed(steps, cutoffIso, deps, where), model, deps, where);
    if (!stmts.length) return 0;
    if (stmts.length > MAX_BATCH) {
        log.warn(`[ConnectorSync] retention purge failed on ${where}: ${stmts.length} statements, more than one transaction takes`);
        return 0;
    }

    let results: BatchResult[];
    try {
        results = await deps.batch(app.userId, app.id, stmts);
    } catch (e) {
        // A background hygiene pass: the transaction rolled back whole, the sync stays successful.
        log.warn(`[ConnectorSync] retention purge failed on ${where}: ${(e as Error).message}`);
        return 0;
    }

    let purged = 0;
    const kept = new Map<string, { n: number; by: string[] }>();
    const files: Array<{ table: string; ids: string[] }> = [];
    meta.forEach((m, i) => {
        const res = results?.[i] || {};
        if (m.kind === 'delete') purged += res.changes || 0;
        else if (m.kind === 'files') files.push({ table: m.step.table.key, ids: fileIdsFromRows(m.fileFields, res.rows) });
        else {
            const row = res.rows?.[0] || {};
            const n = Number(row.kept) || 0;
            if (n > 0) {
                const by = m.referrers.filter((_, j) => Number(row[`r${j}`]) > 0).map((r) => `${r.tableMeta.key}.${r.field}`);
                kept.set(m.step.table.key, { n, by });
            }
        }
    });
    logKept(kept, where);

    // After the commit: the ledger rows and blobs behind the deleted files (refcounted by sha).
    for (const f of files) {
        if (!f.ids.length) continue;
        try {
            await opts.purgeAttachments(f.ids);
        } catch (e) {
            log.warn(`[ConnectorSync] retention purge failed on ${where} (${f.table}): ${(e as Error).message}`);
        }
    }
    if (purged) log.info(`[ConnectorSync] purged ${purged} row(s) past retention on ${where}`);
    return purged;
}

type AttachmentDeps = {
    listAttachments: (appId: string, ownerId: string) => Promise<Array<{ id: string; sha256: string }> | null | undefined>;
    deleteAttachment: (id: string, appId: string, ownerId: string) => Promise<unknown>;
    deleteFile: (key: string) => Promise<unknown>;
    buildAttachmentKey: (ownerId: string, appId: string, sha: string) => string;
};

/**
 * Delete the ledger rows, and the blobs that no longer have a ledger row.
 *
 * Keys are content-addressed by sha256, so two records attaching the identical
 * file share one blob. Deleting it because ONE of them expired would silently
 * break the other — hence the refcount over the remaining ledger.
 */
export async function purgeAttachments(app: App, fileIds: string[], deps: AttachmentDeps): Promise<void> {
    const before = await deps.listAttachments(app.id, app.userId);
    const byId = new Map((before || []).map((a) => [a.id, a]));

    const shas = new Set<string>();
    for (const id of fileIds) {
        const row = byId.get(id);
        if (!row) continue;
        shas.add(row.sha256);
        await deps.deleteAttachment(id, app.id, app.userId);
    }
    if (!shas.size) return;

    const after = await deps.listAttachments(app.id, app.userId); // a failure leaves the blob rather than orphans a live row
    const stillUsed = new Set((after || []).map((a) => a.sha256));
    for (const sha of shas) {
        if (stillUsed.has(sha)) continue;
        await deps.deleteFile(deps.buildAttachmentKey(app.userId, app.id, sha));
    }
}
