/**
 * FORM ANSWERS — a submission becomes a row.
 *
 * Called from the public form route (routes/automation/formPublic.js) at
 * three moments: when page one is submitted (`recordSubmission`, BEFORE the
 * run is queued — the per-automation queue is in memory, so the table must
 * be more durable than the run), when a later page is answered
 * (`recordPageAnswers`), and when the run that carried the journey is known
 * (`attachRun`) and finished (`markCompleted`).
 *
 * ── AS WHOM ────────────────────────────────────────────────────────
 * The table is resolved AS THE AUTOMATION'S OWNER through the same resolver a
 * datatable step uses (resolveDatatableForStep), so a table the owner lost
 * the right to write — transferred, un-granted — refuses here exactly as it
 * would refuse a step. The row's `created_by` is the SUBMITTER, though: it
 * is their answer, and it is what a reader's "who" column shows.
 *
 * ── NEVER IN THE VISITOR'S WAY ─────────────────────────────────────
 * Every function here swallows its errors: a full table, a table that is
 * gone, a refused grade — the submission is still accepted and the run still
 * starts. What went wrong is written to `source.lastWriteError` where the
 * owner sees it on the Form page and on the table.
 *
 * A Solution stage's reference table refuses every row write in the compiler
 * (RowsLockedError); it is recorded like any other refusal, under its class
 * `managed_part`, never rewrapped.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const accessFilter = require('../../core/dataEngine/accessFilter');
const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
const { resolveDatatableForStep } = require('../../core/automationRunner/datatableResolve');
const { resolveDatatablePrincipalForUser } = require('../../auth/datatableAccess');
const derive = require('./derive');
const provision = require('./provision');
const log = require('../../telemetry/log');

const PG = { dialect: 'pg' };
const TAG = '[form answers]';

/** The run-context shape the datatable resolver reads, for the automation's owner. */
async function principalCtxFor(automation) {
    const p = await resolveDatatablePrincipalForUser(automation.userId);
    return {
        userId: automation.userId,
        orgId: automation.organizationId || p.orgId || null,
        userHomeOrgId: p.organizationId || null,
        orgRole: p.orgRole || null,
        userGroupIds: p.groupIds || [],
        identityError: p.identityError || null,
    };
}

/** The linked answers table, resolved as the owner at editor grade, or null. */
async function resolveAnswers(automation, { datatableId = null } = {}) {
    const scope = provision.scopeForAutomation(automation);
    if (!scope) return null;
    const table = datatableId
        ? await datatableStore.getDatatable(datatableId, scope)
        : await provision.tableFor(automation.id, scope);
    if (!table || !table.source || table.source.linked === false) return null;
    const ctx = await principalCtxFor(automation);
    const resolved = await resolveDatatableForStep(table.id, ctx, { needed: 'editor', requireColumns: true });
    return { ...resolved, columnMap: table.source.columnMap || {}, source: table.source };
}

/** Remember what went wrong on the table itself, so the owner sees it. */
async function noteWriteError(automation, table, scope, e) {
    const code = e?.errorClass || e?.code || 'write_failed';
    log.warn(`${TAG} ${automation?.id}: ${code} — ${e?.message}`);
    if (!table || !scope) return;
    try {
        await datatableStore.setDefinitionSource(table.id, scope, {
            ...table.source,
            lastWriteError: { code, message: String(e?.message || '').slice(0, 300), at: new Date().toISOString() },
        });
    } catch (inner) {
        log.warn(`${TAG} could not record the write error: ${inner.message}`);
    }
}

async function clearWriteError(table, scope) {
    if (!table?.source?.lastWriteError) return;
    try {
        await datatableStore.setDefinitionSource(table.id, scope, { ...table.source, lastWriteError: null });
    } catch { /* cosmetic */ }
}

/**
 * Page one: one new row. `{ rowId, datatableId } | null`.
 *
 * `completed_at` is stamped straight away when the form has no further
 * pages — the journey is over the moment page one lands.
 */
async function recordSubmission({ automation, definition, values, submitterId = null }) {
    let r = null;
    try {
        r = await resolveAnswers(automation);
        if (!r) return null;
        // Before the quota: a locked table is refused for that, not as full.
        queryCompiler.assertRowsWritable(r.tableMeta);
        await assertDatatableQuota(r.scope, { table: r.table, addRows: 1 });
        const row = derive.rowValuesFor(r.columnMap, null, values);
        if (derive.inputPagesOf(definition).length === 0) row.completed_at = new Date().toISOString();
        const { sql, params, id } = queryCompiler.compileInsert(r.tableMeta, row, {
            createdBy: submitterId || null, orgId: r.orgId, ...PG,
        });
        await datatableDbStore.exec(r.scopeKey, r.scopeKey, sql, params);
        await datatableStore.bumpAfterWrite(r.table.id, r.scope, 1);
        await clearWriteError(r.table, r.scope);
        return { rowId: id, datatableId: r.table.id };
    } catch (e) {
        await noteWriteError(automation, r && r.table, r && r.scope, e);
        return null;
    }
}

/** A later page: the same row gains that page's answers. */
async function recordPageAnswers({ automation, datatableId, rowId, pageStepId, values }) {
    if (!rowId || !pageStepId) return false;
    let r = null;
    try {
        r = await resolveAnswers(automation, { datatableId });
        if (!r) return false;
        const row = derive.rowValuesFor(r.columnMap, pageStepId, values);
        if (!Object.keys(row).length) return false;
        // `await`, not a bare return: the catch below must see patchRow's
        // refusal (a locked table, a failed write), or it escapes unrecorded.
        return await patchRow(r, rowId, row);
    } catch (e) {
        await noteWriteError(automation, r && r.table, r && r.scope, e);
        return false;
    }
}

/** The journey's root run, once it exists. */
async function attachRun({ automation, datatableId, rowId, run }) {
    if (!rowId || !run) return false;
    try {
        const r = await resolveAnswers(automation, { datatableId });
        if (!r) return false;
        return await patchRow(r, rowId, { run_id: String(run.rootRunId || run.id) });
    } catch (e) {
        log.warn(`${TAG} attachRun: ${e.message}`);
        return false;
    }
}

/** No more pages to answer. */
async function markCompleted({ automation, datatableId, rowId }) {
    if (!rowId) return false;
    try {
        const r = await resolveAnswers(automation, { datatableId });
        if (!r) return false;
        return await patchRow(r, rowId, { completed_at: new Date().toISOString() });
    } catch (e) {
        log.warn(`${TAG} markCompleted: ${e.message}`);
        return false;
    }
}

async function patchRow(r, rowId, values) {
    // The owner's editor filter: the row was written by the form, and the
    // owner may touch every row of a table they own at editor grade.
    const filter = accessFilter.compileAccessFilter(r.tableMeta, 'editor', { id: r.table.ownerUserId || r.table.owner_user_id || null }, 'update', PG);
    const { sql, params } = queryCompiler.compileUpdate(r.tableMeta, String(rowId), values, filter, PG);
    const out = await datatableDbStore.exec(r.scopeKey, r.scopeKey, sql, params);
    const changed = Number(out && out.changes) || 0;
    if (changed) await datatableStore.bumpAfterWrite(r.table.id, r.scope, 0);
    return changed > 0;
}

module.exports = { recordSubmission, recordPageAnswers, attachRun, markCompleted, principalCtxFor, resolveAnswers };
