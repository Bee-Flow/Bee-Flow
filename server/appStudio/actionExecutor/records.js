/**
 * App Studio action executor: RECORD WRITES (extracted verbatim from
 * actionExecutor.js). The writeRecord / writeRecordBatch choke point, the create_record /
 * update_record / delete_record steps, and the best-effort data-version + row-count
 * bookkeeping that follows every write.
 *
 * ── TWO TABLE KINDS, TWO STORAGES ────────────────────────────────────
 *
 * A model table WITHOUT a `source` owns its own storage: that is `writeRecord` below, with
 * `studioAppDbStore` (the owner-scoped per-app engine) and the per-app quota. A model table
 * WITH `source = {kind:'datatable', datatableId, mode}` takes its rows from a Studio
 * datatable outside the app: then it goes to the datatable path at the bottom of this file,
 * `datatableDbStore` on the scope key and the datatable quota.
 *
 * THE SPLIT SITS ON THE NODE ITSELF, not only in the three step handlers. Were it only
 * there, the node would be the second write path that the header below
 * precisely excludes: `writeRecord` and `writeRecordBatch` would write a linked table
 * unconditionally to the app's own storage. Everything that does NOT come in via
 * create_record/update_record/delete_record goes through there: the record API
 * (POST/PATCH/DELETE /:id/data/tables/:tableId/records), ai_extract writeTo, file_intake,
 * dataset_query, the send_email log row, the approval hook, connectorSync and
 * templateInstall. With three consequences at once: a `mode:'read'` link would be writable, the
 * viewer's grade would never be looked up, and the row would land in a shadow table that the READ path
 * (dataReadRunner.readPlan → the datatable) never queries. `success:true`, and the row
 * afterwards visible nowhere.
 *
 * Hence `writeRecord`, `writeRecordBatch` and `eraseRecord` branch themselves, and the step
 * handlers are nothing more than the bindings around them. One branch per node, no single
 * caller with its own copy.
 *
 * WHO MAY WRITE is not decided here. That question lives in `appStudio/datatableSource.js`,
 * together with the answer for the READ path (dataReadRunner): one body, two entries. Two
 * implementations of "which grade applies through this door" drift apart, and the copy that
 * drifts is always the one nobody looks at. What remains here is compiling and executing.
 *
 * The two storages share nothing and must therefore never fall into each other's path: a
 * `source` that cannot be read is an ERROR, not a fallback to the app's own storage.

 */
'use strict';

const queryCompiler = require('../queryCompiler');
const rlsGateway = require('../rlsGateway');
const studioAppDbStore = require('../../stores/studioAppDbStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const { assertRowQuota, assertDbByteQuota } = require('../studioAppQuota');
// De rechtenbeslissing voor de tweede tabelsoort — gedeeld met dataReadRunner.
const datatableSource = require('../datatableSource');
const {
    findTable, buildServerScope, resolveBinding, resolveValues, coerceRecordId, writeViewer,
} = require('./shared');
const log = require('../../telemetry/log');

// ── Record writes ───────────────────────────────────────────────────

/**
 * THE record-write choke point. Every server-side create/update of an app
 * record (the data route POST/PATCH records, the create_record /
 * update_record sequence steps, AI seeding, template install) funnels through
 * here so RLS and storage quotas can never be bypassed by a second write path.
 *
 *   writeRecord(app, model, table, values, { viewer, recordId })
 *     viewer   — { id, role, ... }: role drives RLS (assertCanWrite + access
 *                filter); the other attributes feed row-filter params.
 *     recordId — absent → CREATE (row + byte quotas asserted); present →
 *                UPDATE of that record (byte quota only; 0 changes means the
 *                row is missing OR outside the viewer's scope).
 *
 * `values` are RESOLVED column values ({ [col]: value }). The compiler drops
 * system columns, rejects unknown fields (422) and coerces per type. Quota
 * failures propagate as studioAppQuota errors { status:409,
 * code:'quota_exceeded', limit, used }. Deletes deliberately do NOT come
 * through here; they stay quota-free so a full app can shrink.
 *
 * Returns { id, created:true } or { id, updated, changes }.
 *
 * A LINKED TABLE DOES NOT GO THROUGH HERE. `table.source` is read FIRST: the rows of such a
 * table are in a Studio datatable, and the rights to it are not those of the app. The refusal
 * that then falls is a `readError` (status + `safe:true`) and is passed on literally by the
 * routers; it is never a fallback to `studioAppDbStore`.
 * @param {AppRef} app
 * @param {import('./shared').DataModel} model
 * @param {import('./shared').DataTable} table
 * @param {Record<string, any>} values
 * @param {{ viewer?: any, recordId?: string, expectedUpdatedAt?: any }} [opts]
 */
async function writeRecord(app, model, table, values, { viewer, recordId, expectedUpdatedAt = null } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        return writeDatatableRecord(app, table, values, { viewer, recordId, expectedUpdatedAt });
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;

    if (recordId === undefined || recordId === null) {
        // 403 if this role may not create in this table at all — before quotas
        // so a forbidden write never reads usage.
        rlsGateway.assertCanWrite(table, role, 'create');
        await assertRowQuota(app, table.key);  // 409 at per-table/app row caps
        await assertDbByteQuota(app);          // 409 at the DB byte ceiling
        const { sql, params, id } = queryCompiler.compileInsert(table, values, {
            createdBy: v.id ?? null,
            orgId: app.organizationId || null,
        });
        await studioAppDbStore.exec(app.userId, app.id, sql, params);
        await bumpVersion(app, table.key);
        await bumpCount(app, table.key, 1);
        return { id, created: true };
    }

    // 403 if this role has no update scope; else 'own'/'all'.
    rlsGateway.assertCanWrite(table, role, 'update');
    await assertDbByteQuota(app); // updates only need headroom, not row budget
    const accessFilter = rlsGateway.compileAccessFilter(table, role, v, 'update');
    // expectedUpdatedAt (optional) makes this a compare-and-set: see
    // queryCompiler.compileUpdate. Only the record API passes it.
    const { sql, params } = queryCompiler.compileUpdate(table, recordId, values, accessFilter, { expectedUpdatedAt });
    const res = await studioAppDbStore.exec(app.userId, app.id, sql, params);
    const changes = (res && res.changes) ? res.changes : 0;
    if (changes > 0) await bumpVersion(app, table.key);
    return { id: recordId, updated: changes > 0, changes };
}

/**
 * The BATCH sibling of writeRecord: N creates in ONE store transaction, so a
 * failure part-way through leaves NOTHING behind (an ai_extract writes its whole
 * extraction or none of it). The same create-path gates apply (assertCanWrite,
 * then the row and byte quotas), asserted once for the batch before anything is
 * compiled. Returns the created ids.
 *
 * The same first question as in `writeRecord`: a linked table goes to the datatable or nowhere.
 */
async function writeRecordBatch(app, model, table, rows, { viewer } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        // The permission is ALSO asked for an empty batch, exactly like
        // the own-storage branch below: "you were not allowed to do this" and "there was
        // nothing" are different answers, and only the first is a refusal.
        const bound = await resolveWrite(app, table, viewer, 'create');
        return datatableInsert(bound, Array.isArray(rows) ? rows : []);
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;

    rlsGateway.assertCanWrite(table, role, 'create');
    if (rows.length === 0) return [];
    await assertRowQuota(app, table.key);
    await assertDbByteQuota(app);

    /** @type {({ sql: string; params: (string | null)[]; })[]} */
    const statements = [];
    /** @type {string[]} */
    const ids = [];
    for (const values of rows) {
        const compiled = queryCompiler.compileInsert(table, values, {
            createdBy: v.id ?? null,
            orgId: app.organizationId || null,
        });
        statements.push({ sql: compiled.sql, params: compiled.params });
        ids.push(compiled.id);
    }
    await studioAppDbStore.batch(app.userId, app.id, statements);
    await bumpVersion(app, table.key);
    await bumpCount(app, table.key, ids.length);
    return ids;
}

/**
 * THE record-DELETE choke point: the third entry next to writeRecord/Batch.
 *
 * Deleting did not go through writeRecord (deletes stay quota-free: that is how a full app
 * can shrink). As a result, the same compile-and-exec was written twice: once in the
 * delete_record step and once in the DELETE route. The route was the copy that did not know
 * the second table kind: `DELETE FROM "klanten"` on the app storage, a 404 on a row that does
 * exist in the datatable, and on a table that once WAS its own storage, the silent wipe of the
 * old shadow rows with only the app role as gate.
 *
 * Yields `{ id, deleted, changes }`. 0 rows means "gone OR outside the viewer's scope", and the
 * caller makes one uniform "not found" of that, so the existence of a row never leaks.
 * @param {string} recordId
 */
async function eraseRecord(app, model, table, recordId, { viewer } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        const bound = await resolveWrite(app, table, viewer, 'delete');
        const changes = await datatableDelete(bound, recordId);
        return { id: recordId, deleted: changes > 0, changes };
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;
    rlsGateway.assertCanWrite(table, role, 'delete'); // 403 if this role may not
    const accessFilter = rlsGateway.compileAccessFilter(table, role, v, 'delete');
    const { sql, params } = queryCompiler.compileDelete(table, recordId, accessFilter);
    const res = await studioAppDbStore.exec(app.userId, app.id, sql, params);
    const changes = (res && res.changes) ? res.changes : 0;
    if (changes > 0) {
        await bumpVersion(app, table.key);
        await bumpCount(app, table.key, 0 - changes);
    }
    return { id: recordId, deleted: changes > 0, changes };
}

async function createRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return createDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const values = resolveValues(step.values, ctx, scope);
    const { id } = await writeRecord(app, model, table, values, { viewer: writeViewer(ctx) });
    return { ok: true, result: { id, created: true } };
}

async function updateRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return updateDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    const values = resolveValues(step.values, ctx, scope);
    // Optional compare-and-set (see STEP_SPECS.update_record.expectedUpdatedAt).
    const expectedRaw = step.expectedUpdatedAt !== undefined
        ? resolveBinding(step.expectedUpdatedAt, ctx, scope)
        : null;
    const expectedUpdatedAt = typeof expectedRaw === 'string' && expectedRaw ? expectedRaw : null;

    const { changes } = await writeRecord(app, model, table, values, {
        viewer: writeViewer(ctx), recordId, expectedUpdatedAt,
    });
    if (!changes) {
        // With a token, "no rows" most often means somebody else got there
        // first — say so, because "not found" would send the person looking
        // for a row that is right in front of them.
        if (expectedUpdatedAt) {
            return { ok: false, error: 'This record was changed by someone else — refresh and try again.', code: 'record_conflict' };
        }
        // 0 rows changed = the row is missing OR outside the viewer's scope; a
        // uniform "not found" so we never reveal which.
        return { ok: false, error: 'Record not found' };
    }
    return { ok: true, result: { id: recordId, updated: true, changes } };
}

async function deleteRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return deleteDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    const { changes } = await eraseRecord(app, model, table, recordId, { viewer: writeViewer(ctx) });
    if (!changes) return { ok: false, error: 'Record not found' };
    return { ok: true, result: { id: recordId, deleted: true, changes } };
}

// ── Record writes on a DATATABLE-backed table ───────────────────────
//
// The same three steps as above, but on a different storage. What differs:
//
//   THE RIGHTS are already decided. `datatableSource.resolveDatatableWrite` supplies
//   the grade (MIN of the viewer, the app owner, the app role and the mode), has already
//   refused `mode:'read'`, and has already queried both `access` blocks for THIS
//   action. No permission decision falls here any more; that is precisely why it
//   stands there and not here.
//
//   THE STORAGE is `datatableDbStore` on the scope key, never `studioAppDbStore`: the
//   latter is per app and per owner and does not know these rows. The quotas are those of
//   the datatable TENANT (`assertDatatableQuota`), not the per-app quota. The rows count
//   towards the organisation in which they live, not towards the app that shows them.
//
//   THE DIALECT comes from the resolution (`pg`) and is used everywhere. The App Studio
//   engine flag may say 'sqlite' on the same server; a compile under the wrong dialect is
//   not a crash but silently different SQL.

/**
 * Every refusal of the rights layer carries `safe:true`, the same flag the read path
 * uses (`appStudio/readError.js`), and comes back as a step error WITH the message in it.
 * Without that translation the dispatcher would collapse a 422 or a 503 into "Step failed",
 * and then it would say "something went wrong" where "this table is linked read-only" belongs.
 *
 * Everything without the flag passes UNTOUCHED to the dispatcher, which already knows
 * AccessError (403), CompileError (422) and the quota form (409).
 */
function sourceRefusal(e) {
    if (!e || e.safe !== true) return null;
    return { ok: false, error: e.message, code: 'datatable_source' };
}

/**
 * A row write to a Solution stage's reference table (queryCompiler
 * RowsLockedError): the rows are the release's. Answered as a step failure
 * that keeps its code, so the app can say "change it in Dev and deploy"
 * instead of the dispatcher's generic "Step failed". The record API and the
 * other choke-point callers get the error itself (status 409, code
 * `managed_part`) and answer it as their own 409.
 */
function managedRefusal(e) {
    if (!(e instanceof queryCompiler.RowsLockedError)) return null;
    return { ok: false, error: e.message, code: 'managed_part' };
}

/**
 * The context in which `datatableSource` expects a viewer: the same shape that
 * dataReadRunner passes along, so that reading and writing share one decision.
 * `writeViewer` fills in the role when the route only sent `{id}`.
 */
function sourceCtx(app, ctx) {
    return { app, viewerId: ctx.viewerId ?? null, role: ctx.role ?? null, viewer: writeViewer(ctx) };
}

/** De datatabel-store, lui gerequired zoals overal op dit pad (pg-pool). */
function dtStore() {
    return require('../../stores/datatableDbStore');
}

/**
 * The rights decision, from a `viewer` alone: the shape the nodes receive. `sourceCtx` above
 * does the same from a step ctx; both end in the same `resolveDatatableWrite`, so that the route
 * and the step cannot each come up with their own answer.
 * @param {'delete' | 'create' | 'update'} action
 */
function resolveWrite(app, table, viewer, action) {
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    return datatableSource.resolveDatatableWrite(
        { app, viewerId: v.id ?? null, role: v.role ?? null, viewer: v }, table, action,
    );
}

/**
 * Put N rows into the datatable. One row goes through `exec`, more through `batch`:
 * the same all-or-nothing promise as `writeRecordBatch` on the own storage.
 *
 * The quota is that of the TENANT (`assertDatatableQuota`), not the per-app quota:
 * the rows count towards the organisation in which they live. That is the same check that
 * routes/datatables.js and the automation runner run, so that an app is not the one path
 * along which a full organisation nevertheless keeps growing.
 */
async function datatableInsert(bound, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    // A locked reference table refuses before the quota is read: "the rows
    // are the release's" is the answer, not "the table is full".
    queryCompiler.assertRowsWritable(bound.tableMeta);
    const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
    await assertDatatableQuota(bound.scope, { table: bound.datatable, addRows: list.length });

    // A datatable that mirrors an EXTERNAL SOURCE (core/dataEngine/sources):
    // every row goes FIRST to the source, and the copy follows from the answer. In one write
    // action where the source knows a batch (a file rewritten once), row by row where it does
    // not. A refusal is `safe`, so sourceRefusal passes status/code/sentence through as with
    // any other source refusal.
    if (isSourceMirror(bound)) {
        const out = await mirrorWrites(bound).insertRows(mirrorCtx(bound), list);
        return out.inserted.map(r => r.id);
    }

    /** @type {({ sql: string; params: (string | null)[]; })[]} */
    const statements = [];
    /** @type {string[]} */
    const ids = [];
    for (const values of list) {
        const ins = queryCompiler.compileInsert(bound.tableMeta, values, {
            // The one who made the row is the VIEWER, not the app owner: that is the
            // honest audit field, and it is the column that `row_scope:'own'`
            // filters on. If we stamped the owner, a member would immediately no longer
            // see their own row.
            createdBy: bound.viewer.id ?? null,
            // The org of the TABLE, never that of the app: a personal table
            // has none, and stamping the app's org onto its rows is a lie the access filter
            // has to live with.
            orgId: bound.datatable.organizationId || null,
            dialect: bound.dialect,
        });
        statements.push({ sql: ins.sql, params: ins.params });
        ids.push(ins.id);
    }
    if (statements.length === 1) {
        await dtStore().exec(bound.scopeKey, bound.scopeKey, statements[0].sql, statements[0].params);
    } else {
        await dtStore().batch(bound.scopeKey, bound.scopeKey, statements);
    }
    await bumpDatatable(bound, ids.length);
    return ids;
}

function isSourceMirror(bound) {
    return require('../../core/dataEngine/sources').isSourceMirror(bound?.datatable);
}

/** De write-through van de bron-soort van deze tabel. */
function mirrorWrites(bound) {
    return require('../../core/dataEngine/sources').writeThrough(bound.datatable);
}

function mirrorCtx(bound) {
    return mirrorWrites(bound).contextOf({
        table: bound.datatable, scope: bound.scope, scopeKey: bound.scopeKey,
        tableMeta: bound.tableMeta, grade: bound.grade, viewerId: bound.viewer?.id ?? null,
    });
}

/**
 * Eén rij in de datatabel wijzigen → het aantal geraakte rijen.
 * @param {string} recordId
 * @param {string | null} [expectedUpdatedAt]
 */
async function datatableUpdate(bound, recordId, values, expectedUpdatedAt = null) {
    if (isSourceMirror(bound)) {
        const r = await mirrorWrites(bound).updateRow(mirrorCtx(bound), String(recordId), values, { expectedUpdatedAt });
        return r.changes;
    }
    const accessFilter = rlsGateway.compileAccessFilter(
        bound.tableMeta, bound.grade, bound.viewer, 'update', { dialect: bound.dialect });
    const { sql, params } = queryCompiler.compileUpdate(bound.tableMeta, recordId, values, accessFilter, {
        expectedUpdatedAt, dialect: bound.dialect,
    });
    const res = await dtStore().exec(bound.scopeKey, bound.scopeKey, sql, params);
    const changes = Number(res && res.changes) || 0;
    // Delta 0: an update does not change the row count, but it does change the data version
    // that the cache and a live knowledge source watch.
    if (changes) await bumpDatatable(bound, 0);
    return changes;
}

/**
 * Eén rij uit de datatabel verwijderen → het aantal geraakte rijen.
 * @param {string} recordId
 */
async function datatableDelete(bound, recordId) {
    if (isSourceMirror(bound)) {
        const r = await mirrorWrites(bound).deleteRow(mirrorCtx(bound), String(recordId));
        return r.changes;
    }
    const accessFilter = rlsGateway.compileAccessFilter(
        bound.tableMeta, bound.grade, bound.viewer, 'delete', { dialect: bound.dialect });
    const { sql, params } = queryCompiler.compileDelete(
        bound.tableMeta, recordId, accessFilter, { dialect: bound.dialect });
    const res = await dtStore().exec(bound.scopeKey, bound.scopeKey, sql, params);
    const changes = Number(res && res.changes) || 0;
    // `0 - changes`, niet `-changes`: met changes === 0 levert de unaire vorm
    // -0 op, en dat haalt de store als negatieve nul binnen.
    if (changes) await bumpDatatable(bound, 0 - changes);
    return changes;
}

/**
 * The datatable branch of `writeRecord`: create when recordId is empty, otherwise an
 * update. Answers in exactly the same shape as the own-storage branch, so that no single
 * caller knows which of the two it hit.
 */
async function writeDatatableRecord(app, table, values, { viewer, recordId, expectedUpdatedAt = null } = {}) {
    const creating = recordId === undefined || recordId === null;
    const bound = await resolveWrite(app, table, viewer, creating ? 'create' : 'update');
    if (creating) {
        const [id] = await datatableInsert(bound, [values]);
        return { id, created: true };
    }
    const changes = await datatableUpdate(bound, recordId, values, expectedUpdatedAt);
    return { id: recordId, updated: changes > 0, changes };
}

async function createDatatableRecord(app, table, step, ctx) {
    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'create');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    const scope = buildServerScope(ctx);
    const values = resolveValues(step.values, ctx, scope);
    let id;
    try {
        [id] = await datatableInsert(bound, [values]);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    return { ok: true, result: { id, created: true } };
}

async function updateDatatableRecord(app, table, step, ctx) {
    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'update');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    const values = resolveValues(step.values, ctx, scope);
    // Optioneel compare-and-set, identiek aan de eigen-opslag-tak.
    const expectedRaw = step.expectedUpdatedAt !== undefined
        ? resolveBinding(step.expectedUpdatedAt, ctx, scope)
        : null;
    const expectedUpdatedAt = typeof expectedRaw === 'string' && expectedRaw ? expectedRaw : null;

    let changes;
    try {
        changes = await datatableUpdate(bound, recordId, values, expectedUpdatedAt);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    if (!changes) {
        if (expectedUpdatedAt) {
            return { ok: false, error: 'This record was changed by someone else — refresh and try again.', code: 'record_conflict' };
        }
        // 0 rows = the row does not exist OR falls outside the viewer's scope;
        // one uniform answer, so the existence of a row never leaks.
        return { ok: false, error: 'Record not found' };
    }
    return { ok: true, result: { id: recordId, updated: true, changes } };
}

async function deleteDatatableRecord(app, table, step, ctx) {
    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'delete');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    let changes;
    try {
        changes = await datatableDelete(bound, recordId);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    if (!changes) return { ok: false, error: 'Record not found' };
    return { ok: true, result: { id: recordId, deleted: true, changes } };
}

/**
 * Update the row count + data version of the datatable.
 *
 * Best-effort, with the same rationale as `bumpVersion` below: the row is already committed,
 * so failed bookkeeping must not turn the step red after all.
 * `jobs/datatableRetention` recounts `row_count` authoritatively.
 * @param {number} delta
 */
async function bumpDatatable(bound, delta) {
    try {
        const datatableStore = require('../../stores/datatableStore');
        await datatableStore.bumpAfterWrite(bound.datatable.id, bound.scope, delta);
    } catch (e) {
        log.warn(`[ActionExecutor] datatable bookkeeping failed for ${bound.datatable && bound.datatable.id}: ${/** @type {Error} */ (e).message}`);
    }
}

async function bumpVersion(app, tableKey) {
    try {
        await studioAppDataStore.bumpDataVersion(app.id, tableKey, app.userId);
    } catch (e) {
        // A version-bump miss is a cache-staleness nuisance, not a data error —
        // the write already committed. Don't fail the step over it.
        log.warn(`[ActionExecutor] data-version bump failed for ${app.id}/${tableKey}: ${/** @type {Error} */ (e).message}`);
    }
}

// Best-effort row-count delta (feeds the cached quota reads). Same rationale
// as bumpVersion: the write already committed, never fail over bookkeeping —
// recountRows (on schema saves) heals any drift authoritatively.
/**
 * @param {number} delta
 */
async function bumpCount(app, tableKey, delta) {
    try {
        await studioAppDataStore.bumpRowCount(app.id, tableKey, delta, app.userId);
    } catch (e) {
        log.warn(`[ActionExecutor] row-count bump failed for ${app.id}/${tableKey}: ${/** @type {Error} */ (e).message}`);
    }
}

module.exports = {
    writeRecord,
    writeRecordBatch,
    eraseRecord,
    createRecord,
    updateRecord,
    deleteRecord,
};

/**
 * @typedef {{ id: string, userId: string, organizationId?: string | null }} AppRef
 * @typedef {{ kind?: string, tableId?: string, values?: Record<string, import('./shared').Binding>, recordId?: import('./shared').Binding,
 *   expectedUpdatedAt?: import('./shared').Binding }} RecordStep
 * @typedef {Awaited<ReturnType<typeof datatableSource.resolveDatatableWrite>>} Bound  a resolved datatable write
 */
