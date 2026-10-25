// @typecheck noImplicitAny
/**
 * The single-row write-through and the checks every write shares, for
 * ./writeThrough.js (which documents the contract and the order) and
 * ./writeThroughBatch.js.
 *
 * Every function takes the write-through `w` makeWriteThrough builds:
 *   { adapter, Err, notFound: Set<string> }
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const accessFilter = require('../../accessFilter');
const { gradeAtLeast } = require('../../../../auth/datatableAccess');
const { isSourceError } = require('./errors');
const { PG } = require('./constants');

const UNAVAILABLE = 'datatable_source_unavailable';

/**
 * What every write site hands over (writeThrough.contextOf).
 * @typedef {{ table: NonNullable<ReturnType<typeof import('../../../../stores/datatableStore/rowMappers').rowToDatatable>>,
 *             scope: { kind: string, id: string }, scopeKey: string,
 *             tableMeta: Omit<import('../../accessFilter').AccessTableMeta, 'fields'> & { key?: string, rowsLocked?: boolean,
 *               fields?: Array<{ id: string, key: string, name?: string, type?: string, derived?: string | boolean, computed?: { stored?: boolean } }> },
 *             grade?: string | null, viewerId?: string | null }} WriteCtx
 */
/**
 * The adapter a kind hands to makeWriteThrough (see ./writeThrough.js "THE ADAPTER").
 * @typedef {{ KIND: string, isMirror: (table: unknown) => boolean,
 *             Err: new (status: number, code: string, message: string, opts?: { errorClass?: string }) => Error,
 *             forbiddenCode: string, notFoundCodes?: Iterable<string>,
 *             toWire: (ctx: WriteCtx, values: unknown) => unknown,
 *             apiFor: (ctx: WriteCtx) => Promise<unknown>,
 *             sourceInsert: (api: unknown, ctx: WriteCtx, wire: unknown) => Promise<unknown>,
 *             sourceUpdate: (api: unknown, ctx: WriteCtx, rowId: string, wire: unknown) => Promise<unknown>,
 *             sourceDelete: (api: unknown, ctx: WriteCtx, rowId: string) => Promise<unknown>,
 *             sourceInsertMany?: (api: unknown, ctx: WriteCtx, wires: unknown[]) => Promise<unknown[]>,
 *             sourceUpdateMany?: (api: unknown, ctx: WriteCtx, items: Array<{ rowId: string, wire: unknown }>) => Promise<unknown[]>,
 *             sourceDeleteMany?: (api: unknown, ctx: WriteCtx, rowIds: string[]) => Promise<unknown>,
 *             localValuesFor: (ctx: WriteCtx, raw: unknown, opts: { rowId?: string }) => Promise<{ id: string, values: object }> }} WriteAdapter
 */
/**
 * The write-through `w` makeWriteThrough builds; the row methods are set right after.
 * @typedef {{ adapter: WriteAdapter, Err: WriteAdapter['Err'], notFound: Set<string>,
 *             insertRow?: (ctx: WriteCtx, values: unknown) => ReturnType<typeof insertRow>,
 *             updateRow?: (ctx: WriteCtx, rowId: string, values: unknown, opts?: { expectedUpdatedAt?: string | null }) => ReturnType<typeof updateRow>,
 *             deleteRow?: (ctx: WriteCtx, rowId: string) => ReturnType<typeof deleteRow> }} Writer
 */

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameInstant(a, b) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
    return String(a) === String(b);
}

/**
 * @param {Writer} w
 * @param {WriteCtx} ctx
 */
function assertCtx(w, ctx) {
    if (!ctx || !ctx.table || !w.adapter.isMirror(ctx.table) || !ctx.table.source) {
        throw new Error(`writeThrough: not a ${w.adapter.KIND} mirror`);
    }
    if (!ctx.tableMeta || !ctx.tableMeta.access) throw new Error('writeThrough: tableMeta with access is required');
    if (!ctx.scope || !ctx.scopeKey) throw new Error('writeThrough: scope and scopeKey are required');
}

/**
 * @param {WriteCtx} ctx
 * @param {string} action
 */
function callerFilter(ctx, action) {
    return accessFilter.compileAccessFilter(ctx.tableMeta, ctx.grade, { id: ctx.viewerId || null }, action, PG);
}

/**
 * @param {WriteCtx} ctx
 * @param {string} action
 */
function ownerFilter(ctx, action) {
    return accessFilter.compileAccessFilter(ctx.tableMeta, 'owner', { id: null }, action, PG);
}

/**
 * @param {Writer} w
 * @param {WriteCtx} ctx
 * @param {string} action
 */
function assertEditor(w, ctx, action) {
    if (!gradeAtLeast(ctx.grade, 'editor')) {
        throw new w.Err(403, w.adapter.forbiddenCode, 'This needs editor access to the datatable', { errorClass: 'datatable_forbidden' });
    }
    accessFilter.assertCanWrite(ctx.tableMeta, ctx.grade, action);
}

/**
 * @param {string} rowId
 */
function assertRowId(rowId) {
    if (typeof rowId !== 'string' || !rowId) throw new queryCompiler.CompileError('record id is required');
}

/**
 * @param {Writer} w
 * @param {{ name?: string, code?: string } | null | undefined} e
 */
function isNotFound(w, e) {
    return isSourceError(e) && w.notFound.has(e.code);
}

/**
 * @param {WriteCtx} ctx
 * @param {string} id
 */
async function readBack(ctx, id) {
    const probe = queryCompiler.compileGetById(ctx.tableMeta, id, callerFilter(ctx, 'read'), PG);
    const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, probe.sql, probe.params);
    return (found.rows || [])[0] || null;
}

/**
 * The copy row the caller may act on, or null.
 * @param {WriteCtx} ctx
 * @param {string} action
 * @param {string} rowId
 */
async function probeCopy(ctx, rowId, action) {
    const probe = queryCompiler.compileGetById(ctx.tableMeta, rowId, callerFilter(ctx, action), PG);
    const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, probe.sql, probe.params);
    return (found.rows || [])[0] || null;
}

/**
 * The source no longer has it: neither should the copy.
 * @param {WriteCtx} ctx
 * @param {string} rowId
 */
async function dropLocal(ctx, rowId) {
    const del = queryCompiler.compileDelete(ctx.tableMeta, rowId, ownerFilter(ctx, 'delete'), PG);
    const gone = await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, del.sql, del.params);
    const changes = Number(gone && gone.changes) || 0;
    if (changes) await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, -changes);
    return changes;
}

/**
 * @param {WriteCtx} ctx
 * @param {string} id
 * @param {object} local
 */
function insertStatement(ctx, id, local) {
    return queryCompiler.compileInsert(ctx.tableMeta, local, {
        ...PG, id, createdBy: ctx.viewerId || ctx.table.source.linkedByUserId || null, orgId: ctx.table.organizationId || null,
    });
}

/**
 * What the source answered is the truth — written without a token.
 * @param {Writer} w
 * @param {WriteCtx} ctx
 * @param {string} rowId
 * @param {unknown} raw
 */
async function rewriteCopy(w, ctx, rowId, raw) {
    const { values: local } = await w.adapter.localValuesFor(ctx, raw, { rowId });
    const upd = queryCompiler.compileUpdate(ctx.tableMeta, rowId, local, ownerFilter(ctx, 'update'), PG);
    await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, upd.sql, upd.params);
    await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, 0);
    return { changes: 1, row: await readBack(ctx, rowId) };
}

// ── single rows ────────────────────────────────────────────────────────

/**
 * @param {Writer} w
 * @param {WriteCtx} ctx
 * @param {unknown} values
 */
async function insertRow(w, ctx, values) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'create');
    const wire = w.adapter.toWire(ctx, values);
    const api = await w.adapter.apiFor(ctx);
    const raw = await w.adapter.sourceInsert(api, ctx, wire);
    const { id, values: local } = await w.adapter.localValuesFor(ctx, raw, {});
    const ins = insertStatement(ctx, id, local);
    await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, ins.sql, ins.params);
    await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, 1);
    return { id, row: await readBack(ctx, id) };
}

/**
 * @param {Writer} w
 * @param {WriteCtx} ctx
 * @param {string} rowId
 * @param {unknown} values
 * @param {{ expectedUpdatedAt?: string | null }} [opts]
 */
async function updateRow(w, ctx, rowId, values, { expectedUpdatedAt = null } = {}) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'update');
    assertRowId(rowId);
    const wire = w.adapter.toWire(ctx, values);

    // The copy first, with the CALLER's rights: not theirs → not found; stale
    // token → conflict. Neither asks the source anything.
    const current = await probeCopy(ctx, rowId, 'update');
    if (!current) return { changes: 0, row: null };
    if (expectedUpdatedAt && !sameInstant(current.updated_at, expectedUpdatedAt)) {
        return { changes: 0, row: current };
    }

    const api = await w.adapter.apiFor(ctx);
    let raw;
    try {
        raw = await w.adapter.sourceUpdate(api, ctx, rowId, wire);
    } catch (e) {
        if (isNotFound(w, e)) {
            await dropLocal(ctx, rowId);
            return { changes: 0, row: null };
        }
        throw e;
    }
    return rewriteCopy(w, ctx, rowId, raw);
}

/**
 * @param {Writer} w
 * @param {WriteCtx} ctx
 * @param {string} rowId
 */
async function deleteRow(w, ctx, rowId) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'delete');
    assertRowId(rowId);
    if (!await probeCopy(ctx, rowId, 'delete')) return { changes: 0 };

    const api = await w.adapter.apiFor(ctx);
    try {
        await w.adapter.sourceDelete(api, ctx, rowId);
    } catch (e) {
        // Already gone at the source counts as deleted.
        if (!isNotFound(w, e)) throw e;
    }
    const del = queryCompiler.compileDelete(ctx.tableMeta, rowId, ownerFilter(ctx, 'delete'), PG);
    const out = await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, del.sql, del.params);
    const changes = Number(out && out.changes) || 0;
    if (changes) await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, -changes);
    return { changes };
}

module.exports = {
    UNAVAILABLE, sameInstant,
    assertCtx, assertEditor, assertRowId, ownerFilter, readBack, probeCopy, dropLocal, insertStatement, rewriteCopy,
    insertRow, updateRow, deleteRow,
};
