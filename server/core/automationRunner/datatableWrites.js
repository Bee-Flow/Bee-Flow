/**
 * The WRITE half of the `datatable` step (./execDatatable.js holds the
 * refusals in its header, the tenant and grade resolution, the conditions and
 * the reads). Everything here runs after those: the values are resolved and
 * screened, the permission is asserted, a preview is synthesised, and then a
 * row is added, upserted, updated or deleted — on the local copy, or through
 * the source when the table mirrors one.
 *
 * Every function takes the step context `t` execDatatable builds:
 *   { step, ctx, runState, op, mode, table, scope, scopeKey, orgId, grade,
 *     tableMeta, declared, filters, match, readFilter, writeFilter, accessAction }
 */

'use strict';

const { resolveInputs } = require('../automationModel/bind');
const { normaliseCells } = require('./datatableCells');
const { DATATABLE_MAX_LIMIT } = require('../automationModel/constants');
// The storage envelope, shared with routes/datatables.js so the HTTP surface
// and the runner cannot disagree about whether a tenant is full.
const { assertDatatableQuota } = require('../dataEngine/datatableLimits');
const {
    PG, MIRROR_WRITE_MAX_PER_STEP, WRITE_CHUNK,
    sources, isMirror, mirrorWrites, mirrorCtx, fail, skipped, emptyOutput,
} = require('./datatableStepShared');

// Required lazily: the runner must stay loadable in suites that stub the DB,
// and these pull in the pg pool.
const stores = () => ({
    datatableStore: require('../../stores/datatableStore'),
    datatableDbStore: require('../../stores/datatableDbStore'),
    queryCompiler: require('../dataEngine/queryCompiler'),
    accessFilter: require('../dataEngine/accessFilter'),
    assertQuota: assertDatatableQuota,
});

/** A credential must never become a permanent row (refusal #4). */
function refuseSecrets(ctx, resolvedValues) {
    // Rows deliberately skip redactForPersistence (they are the user's own
    // data, not a log), so this is the one place that path is closed.
    const secretValues = typeof ctx.secretValues === 'function' ? ctx.secretValues() : null;
    if (!Array.isArray(secretValues) || !secretValues.length) return;
    for (const v of Object.values(resolvedValues)) {
        if (typeof v === 'string' && secretValues.some(sv => sv && v.includes(sv))) {
            throw fail(
                'That would write a credential into a datatable row. Use the secret where it is needed instead of storing it.',
                'datatable_secret_refused',
            );
        }
    }
}

/**
 * The values this write may carry, or the amber skip that stops it. A cell
 * is data: a list in a `{{…}}` is stored as JSON, as it always was.
 * @returns {{ values: object } | { skip: object }}
 */
function prepareWriteValues(t) {
    const { step, ctx, runState, op, table, declared } = t;
    const resolvedValues = resolveInputs(step.values || {}, runState, { allowSecrets: false, listAs: 'json' });
    refuseSecrets(ctx, resolvedValues);
    for (const key of Object.keys(resolvedValues)) {
        if (!declared.has(key)) {
            return { skip: skipped('datatable_column_unknown', `the column "${key}" is no longer on "${table.name}"`, emptyOutput(op)) };
        }
    }
    if (op === 'save_row' && !declared.has(step.matchColumn)) {
        // A renamed match column used to reach compileRecordList and throw a
        // raw CompileError naming the compiler rather than the table. Same
        // amber skip the value columns already take.
        return {
            skip: skipped('datatable_column_unknown',
                `the match column ${step.matchColumn ? `"${step.matchColumn}"` : '(none chosen)'} is no longer on "${table.name}"`,
                emptyOutput(op)),
        };
    }
    // A live write carries the types of its columns (and fails naming the
    // column when a value cannot be one); a preview keeps its synthetic cells.
    const typed = t.mode === 'dry_run' ? resolvedValues : normaliseCells(t.tableMeta, resolvedValues);
    if (op !== 'update_rows') return { values: typed };
    // An unresolved value may never overwrite a real column (refusal #5): a
    // ref that found nothing resolves to `undefined` → coerceValue → NULL, a
    // template that found nothing resolves to '', and an update writes that
    // over every row it matched. Dropping the key leaves the column alone —
    // the promise formState.buildPatch already makes in the editor. An
    // explicit {kind:'literal', value:null} survives, because writing NULL IS
    // the author's choice. add_row/save_row keep empties: a new row's blank is
    // a blank, not a silent overwrite of something that was there.
    const values = {};
    const dropped = [];
    for (const [k, v] of Object.entries(resolvedValues)) {
        if (v === undefined || v === '') { dropped.push(k); continue; }
        values[k] = v;
    }
    if (t.mode !== 'dry_run') Object.assign(values, normaliseCells(t.tableMeta, values));
    if (!Object.keys(values).length) {
        return {
            skip: skipped('datatable_values_unresolved',
                `nothing left to write — ${dropped.map(k => `"${k}"`).join(', ')} came out empty, and writing ${dropped.length > 1 ? 'those columns' : 'that column'} blank would overwrite real data`,
                emptyOutput(op)),
        };
    }
    return { values };
}

/**
 * BEFORE the preview is synthesised: an author who may not write should be
 * told while building, not on the first live run. An upsert can take either
 * branch, so it needs both permissions before either one runs.
 */
function assertWritable(t, { accessFilter, queryCompiler }) {
    if (t.op === 'save_row') {
        accessFilter.assertCanWrite(t.tableMeta, t.grade, 'create');
        accessFilter.assertCanWrite(t.tableMeta, t.grade, 'update');
    } else {
        accessFilter.assertCanWrite(t.tableMeta, t.grade, t.accessAction);
    }
    // A Solution stage's reference table: its rows are the release's. The
    // compiler refuses every write on it (RowsLockedError, errorClass
    // `managed_part`, which an on_error branch matches); asked here as well so
    // a preview says so instead of synthesising a write the live run refuses.
    queryCompiler.assertRowsWritable(t.tableMeta);
}

/**
 * save_row: find the existing row by the author's match column first. An
 * upsert compiled as INSERT-then-retry would need a unique index the author
 * may not have declared; a lookup works either way and keeps the access
 * filter in the WHERE. Returns the step result, or null when there is no
 * such row (the caller then adds one).
 */
async function saveExistingRow(t, values, s) {
    const matchValue = values[t.step.matchColumn];
    if (matchValue === undefined || matchValue === null) return null;
    // A text match ignores capitalisation ("A@X.COM" is the row "a@x.com"),
    // like the Set step's groupId; a number, date or yes/no compares exactly.
    const matchField = (t.tableMeta.fields || []).find(f => f.key === t.step.matchColumn);
    const ci = !!matchField && (matchField.type === 'text' || matchField.type === 'select' || matchField.type === 'richtext');
    const probe = s.queryCompiler.compileRecordList(t.tableMeta, {
        filters: [{ field: t.step.matchColumn, op: 'eq', value: matchValue, ...(ci ? { ci: true } : {}) }],
        limit: 1, dialect: 'pg',
    }, t.readFilter);
    const found = await s.datatableDbStore.query(t.scopeKey, t.scopeKey, probe.sql, probe.params);
    const existing = (found.rows || [])[0];
    if (!existing) return null;
    if (isMirror(t.table)) {
        const r = await mirrorWrites(t.table).updateRow(mirrorCtx(t), existing.id, values);
        return { output: { row: r.row || { ...existing, ...values }, id: existing.id, created: false, updated: r.changes } };
    }
    const upd = s.queryCompiler.compileUpdate(t.tableMeta, existing.id, values, t.writeFilter, { dialect: 'pg' });
    const res = await s.datatableDbStore.exec(t.scopeKey, t.scopeKey, upd.sql, upd.params);
    await s.datatableStore.bumpAfterWrite(t.table.id, t.scope, 0);
    // The real row count, not a hard-coded 1: the row can be readable and
    // still out of the UPDATE's scope, and reporting 1 for a statement that
    // changed nothing is how a automation claims to have saved something it
    // did not.
    return { output: { row: { ...existing, ...values, updated_at: upd.updatedAt }, id: existing.id, created: false, updated: Number(res?.changes ?? 0) } };
}

async function addRow(t, values, s) {
    // The storage envelope — the SAME check routes/datatables.js runs, so
    // the two cannot disagree about whether a table is full.
    // validate/constants.js promises authors that a datatable step "fails
    // on … a quota" so an on_error branch catches something; only the HTTP
    // route ever enforced it, and only the per-table row cap, so in a
    // automation it caught nothing and the shared volume had no ceiling at all.
    await s.assertQuota(t.scope, { table: t.table, addRows: 1 });
    // A mirror: the source first, the copy from its answer. A refusal
    // carries `errorClass`, so an on_error branch matches it like any
    // other datatable failure.
    if (isMirror(t.table)) {
        const r = await mirrorWrites(t.table).insertRow(mirrorCtx(t), values);
        return { output: { row: r.row || { ...values, id: r.id }, id: r.id, created: true, updated: 0 } };
    }
    const ins = s.queryCompiler.compileInsert(t.tableMeta, values, { createdBy: t.ctx.userId, orgId: t.orgId, dialect: 'pg' });
    await s.datatableDbStore.exec(t.scopeKey, t.scopeKey, ins.sql, ins.params);
    await s.datatableStore.bumpAfterWrite(t.table.id, t.scope, 1);
    // compileInsert mints the id and this used to throw it away, while the
    // variable picker (Builder/mapping/upstream.js) has always advertised
    // steps.<id>.output.row.id. Both save_row branches and add_row now
    // return ONE shape.
    // The system columns compileInsert stamped, so the row has the same keys
    // the updating branch returns (it spreads the stored row).
    const row = {
        ...values, id: ins.id, created_at: ins.createdAt, updated_at: ins.createdAt,
        created_by: t.ctx.userId || null, org_id: t.orgId || null,
    };
    return { output: { row, id: ins.id, created: true, updated: 0 } };
}

/**
 * A mirror's targets go to the source — in ONE write where the source has a
 * batch call (a file rewritten once), one at a time where it has not —
 * capped at MIRROR_WRITE_MAX_PER_STEP. Beyond the cap a delete FAILS (a green
 * partial delete is worse than a red step) and an update reports
 * `truncated`. The first refusal aborts the step; the rows already changed
 * are consistent on both sides.
 */
async function mirrorUpdateOrDelete(t, values, ids, truncated) {
    const { op, table } = t;
    const where = sources().sourceLabel(table);
    if (ids.length > MIRROR_WRITE_MAX_PER_STEP && op === 'delete_rows') {
        throw fail(
            `This would delete more than ${MIRROR_WRITE_MAX_PER_STEP} rows of the linked ${where} table "${table.name}" in one step. Narrow the conditions, or delete in batches.`,
            'datatable_too_many_rows',
        );
    }
    const wt = mirrorWrites(table);
    const mctx = mirrorCtx(t);
    const slice = ids.slice(0, MIRROR_WRITE_MAX_PER_STEP);
    const done = op === 'delete_rows'
        ? (await wt.deleteRows(mctx, slice)).changed
        : (await wt.updateRows(mctx, slice.map(id => ({ id, values })))).changed;
    const cut = truncated || ids.length > MIRROR_WRITE_MAX_PER_STEP;
    return op === 'delete_rows'
        ? { output: { deleted: done, truncated: cut } }
        : { output: { updated: done, truncated: cut, ...(cut ? { warning: `Only the first ${slice.length} matching rows were changed — more matched.` } : {}) } };
}

/**
 * ONE transaction per chunk instead of one per row. 800 rows used to be 801
 * round trips with no atomicity anywhere: a crash half way left half the rows
 * written and bumpAfterWrite never reached, so row_count kept counting
 * deletions that had happened.
 */
async function localUpdateOrDelete(t, values, ids, truncated, s) {
    const { op, table, scope, scopeKey, tableMeta, writeFilter } = t;
    let n = 0;
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
        const chunk = ids.slice(i, i + WRITE_CHUNK).map(id => (op === 'delete_rows'
            ? s.queryCompiler.compileDelete(tableMeta, id, writeFilter, PG)
            : s.queryCompiler.compileUpdate(tableMeta, id, values, writeFilter, { dialect: 'pg' })));
        const results = await s.datatableDbStore.batch(scopeKey, scopeKey,
            chunk.map(c => ({ sql: c.sql, params: c.params })));
        // pgAppEngine ALWAYS returns { changes: rowCount }, so the old
        // `res?.changes ? … : 1` fallback only ever lied: it counted a 0-row
        // statement as 1, and bumpAfterWrite then subtracted deletions that
        // never happened.
        let chunkChanges = 0;
        for (const r of (results || [])) chunkChanges += Number(r?.changes ?? 0);
        n += chunkChanges;
        // Bumped per chunk, inside the same flow: the chunk is committed, so
        // the counter has to move with it or a later chunk throwing leaves
        // row_count describing a table that no longer exists that way.
        // `0 - x`, not `-x`: with x === 0 the unary form yields -0, which
        // survives into the store's delta as a negative zero.
        await s.datatableStore.bumpAfterWrite(table.id, scope,
            op === 'delete_rows' ? 0 - chunkChanges : 0);
    }
    if (!ids.length) await s.datatableStore.bumpAfterWrite(table.id, scope, 0);
    const warning = truncated
        ? `Only the first ${DATATABLE_MAX_LIMIT} matching rows were changed — more matched.`
        : undefined;
    return op === 'delete_rows'
        ? { output: { deleted: n, truncated } }
        : { output: { updated: n, truncated, ...(warning ? { warning } : {}) } };
}

/**
 * update_rows / delete_rows — both bounded by at least one resolved condition
 * (the validator requires it, and execDatatable's skip enforces it at run time
 * when a binding comes back empty).
 *
 * DATATABLE_MAX_LIMIT + 1 targets are selected, not DATATABLE_MAX_LIMIT: the
 * extra row is how the step knows the match was larger than it can handle.
 * Without it, `{deleted: 1000}` on a 5,000-row match reported success for a
 * job it had done a fifth of.
 */
async function updateOrDeleteRows(t, values, s) {
    const targets = s.queryCompiler.compileRecordList(t.tableMeta, {
        filters: t.filters, match: t.match, limit: DATATABLE_MAX_LIMIT + 1, dialect: 'pg',
    }, t.writeFilter);
    const found = await s.datatableDbStore.query(t.scopeKey, t.scopeKey, targets.sql, targets.params);
    const allIds = (found.rows || []).map(r => r.id).filter(Boolean);
    const truncated = allIds.length > DATATABLE_MAX_LIMIT;
    const ids = allIds.slice(0, DATATABLE_MAX_LIMIT);
    if (truncated && t.op === 'delete_rows') {
        // A DESTRUCTIVE partial write that reports success is worse than a
        // failed step: nobody re-runs a green delete, so the remaining rows sit
        // there believed gone. An update is recoverable — it is reported as
        // truncated and the author can narrow the condition and run it again.
        throw fail(
            `This would delete more than ${DATATABLE_MAX_LIMIT} rows of "${t.table.name}" in one step. Narrow the conditions, or delete in batches.`,
            'datatable_too_many_rows',
        );
    }
    if (isMirror(t.table)) return mirrorUpdateOrDelete(t, values, ids, truncated);
    return localUpdateOrDelete(t, values, ids, truncated, s);
}

/**
 * Every write op, from the values to the result. `s` is the store set
 * (datatableStore, datatableDbStore, queryCompiler, accessFilter); tests hand
 * in their own, a run takes the real ones.
 */
async function runDatatableWrite(t, s = stores()) {
    const prepared = prepareWriteValues(t);
    if (prepared.skip) return prepared.skip;
    const { values } = prepared;
    assertWritable(t, s);
    if (t.mode === 'dry_run') {
        // A preview must not leave rows behind — and it must not describe a
        // shape the live path never returns, or the author binds to a field
        // that only exists in previews.
        const preview = t.op === 'delete_rows' ? { deleted: 0 }
            : t.op === 'update_rows' ? { updated: 0 }
                : { row: values, id: null, created: true, updated: 0 };
        return { output: { ...preview, _dryRunSynthesised: true } };
    }
    if (t.op === 'add_row' || t.op === 'save_row') {
        const saved = t.op === 'save_row' ? await saveExistingRow(t, values, s) : null;
        return saved || addRow(t, values, s);
    }
    return updateOrDeleteRows(t, values, s);
}

module.exports = { runDatatableWrite };
