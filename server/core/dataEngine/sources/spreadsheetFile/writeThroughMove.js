// @typecheck
const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const accessFilter = require('../../accessFilter');
const { SYSTEM_COLUMNS } = require('../../dataModel/vocabulary');
const { buildRelationIndexes } = require('../mirror/relations');
const { ownerFilter } = require('../mirror/access');
const { PG } = require('../mirror/constants');
const { SpreadsheetSourceError } = require('./errors');
const { writeCell } = require('./cells');
const identity = require('./identity');
const { rowFromSheet, fieldsByIdOf } = require('./rows');
const { syncModule, flagBehind, scratchOf } = require('./writeThroughFile');

function derivedColumn(field, key, entry) {
    const name = field.name || key;
    const why = entry && entry.formula
        ? `"${name}" holds a formula in the file and is read-only here — change the cells it is computed from.`
        : `"${name}" is filled in from a relation and cannot be set directly — change the column it is derived from.`;
    return new SpreadsheetSourceError(400, 'derived_column', why);
}

/**
 * The caller's `values` → `{ cells: Map<fieldId, writeValue>, key }` where
 * `key` is `{ fieldId, value, id }` when the key column is among them (the
 * id the row will have after the write). Derived, formula and unknown
 * columns refused; system columns dropped; every value through the strict
 * write codec.
 */
function toWire(ctx, values) {
    const source = ctx.table.source;
    const map = source.columnMap || {};
    const ident = identity.identityOf(source);
    const keyFieldId = ident.mode === 'key' ? ident.keyFieldId : null;
    const byKey = new Map((ctx.tableMeta.fields || []).filter(f => f && f.key).map(f => [f.key, f]));
    const cells = new Map();
    let key = null;
    const given = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    for (const [k, v] of Object.entries(given)) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        const field = byKey.get(k);
        if (!field) throw new queryCompiler.CompileError(`unknown field: ${k}`);
        const entry = map[field.id];
        if (!entry || entry.derived || entry.formula || field.derived) throw derivedColumn(field, k, entry);
        const value = writeCell(v, { ...entry, type: entry.type || field.type, header: entry.header || field.name || k });
        cells.set(field.id, value);
        if (field.id === keyFieldId) {
            // Typed like the pass mints it (identity.js): a number key's id
            // is the same whatever the file's spelling of the number.
            const id = identity.rowIdFromKey(value, entry.type || field.type);
            if (id === null) {
                throw new SpreadsheetSourceError(422, 'key_missing',
                    `"${entry.header || field.name || k}" is the key column and cannot be empty.`, { detail: entry.header || k });
            }
            key = { fieldId: field.id, value, id };
        }
    }
    return { cells, key };
}

const indexMemo = new WeakMap();

/** The relation indexes, once per write call (the shared half asks per row). */
function indexesFor(ctx) {
    if (!indexMemo.has(ctx)) indexMemo.set(ctx, buildRelationIndexes(ctx.scope, ctx.table.source));
    return indexMemo.get(ctx);
}

/** The copy's values for a sheet row, derived columns included. */
async function localValuesFor(ctx, raw, { rowId = null } = {}) {
    const idx = await indexesFor(ctx);
    const id = (raw && raw.id) || rowId;
    const row = rowFromSheet({ id, rowNumber: raw && raw.rowNumber, cells: (raw && raw.cells) || [] }, {
        columnMap: (raw && raw.columnMap) || ctx.table.source.columnMap,
        fieldsById: fieldsByIdOf(ctx.tableMeta),
        relationIndexes: idx.relationIndexes,
        labelIndexes: idx.labelIndexes,
    });
    return row || { id, values: {} };
}

function callerFilter(ctx, action) {
    return accessFilter.compileAccessFilter(ctx.tableMeta, ctx.grade, { id: ctx.viewerId || null }, action, PG);
}

async function readBack(ctx, id) {
    const q = queryCompiler.compileGetById(ctx.tableMeta, id, callerFilter(ctx, 'read'), PG);
    const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, q.sql, q.params);
    return (found.rows || [])[0] || null;
}

/** Does this update change the row's key? → the id it will have. */
function keyMoveOf(ctx, rowId, values) {
    if (!ctx || !ctx.table || !ctx.table.source || !ctx.tableMeta) return null;
    if (identity.identityOf(ctx.table.source).mode !== 'key') return null;
    const wire = toWire(ctx, values);
    return wire.key && wire.key.id !== rowId ? wire.key.id : null;
}

/**
 * The key column changed: the copy row moves from `oldId` to `newId` in one
 * batch (delete + insert — the id is the primary key, and a relation that
 * pointed at the old id is re-resolved by the next pass).
 */
async function moveCopy(ctx, oldId, newId, before) {
    const raw = scratchOf(ctx).raws.get(oldId);
    if (!raw) return { ...before };
    const { values } = await localValuesFor(ctx, raw, { rowId: newId });
    const del = queryCompiler.compileDelete(ctx.tableMeta, oldId, ownerFilter(ctx.tableMeta, 'delete'), PG);
    const ins = queryCompiler.compileInsert(ctx.tableMeta, values, {
        ...PG, id: newId,
        createdBy: (before.row && before.row.created_by) || ctx.viewerId || ctx.table.source.linkedByUserId || null,
        orgId: ctx.table.organizationId || null,
    });
    await datatableDbStore.batch(ctx.scopeKey, ctx.scopeKey, [del, ins].map(s => ({ sql: s.sql, params: s.params })));
    await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, 0);
    return { ...before, id: newId, row: await readBack(ctx, newId) };
}

/**
 * Row mode: after a delete every row number under it moved — one pass
 * renumbers the copy. The stale mark is what makes the pass read: record()
 * just wrote the new marker, and an unmarked pass would answer "unchanged".
 * It is set BEFORE the claim, so a pass that already holds the claim (it
 * read the file before our PUT) keeps the mark when it finishes and the
 * next tick renumbers — its claim is never taken over (no `syncRows`
 * option does that any more: two passes writing one copy at once can
 * leave the older rows in it under the new marker).
 * @returns {Promise<boolean>} whether the copy was renumbered now
 */
async function renumber(ctx) {
    await datatableStore.markSourceStale(ctx.table.id, 'write');
    const fresh = await datatableStore.getDatatable(ctx.table.id, ctx.scope);
    if (!fresh) return false;
    const r = await syncModule().syncRows(fresh, { reason: 'write' });
    if (r && r.alreadyRunning) {
        // A kick for the moment that pass is done (a no-op while it runs:
        // the mark it keeps has the next tick or pulse do it).
        await flagBehind(ctx, 'write');
        return false;
    }
    return !!(r && r.ok);
}

module.exports = { toWire, localValuesFor, keyMoveOf, moveCopy, renumber };
