/**
 * The BATCH forms of the write-through (see "BATCH FORMS" in
 * ./writeThrough.js): one source write for a list where the adapter has a
 * batch call, the per-row loop where it has not, and `collect` deciding
 * whether a per-row refusal is reported or thrown.
 *
 * Every function takes the write-through `w` makeWriteThrough builds:
 *   { adapter, Err, notFound, insertRow(), updateRow(), deleteRow() }
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const { PG, WRITE_CHUNK } = require('./constants');
const {
    UNAVAILABLE, sameInstant,
    assertCtx, assertEditor, assertRowId, ownerFilter, readBack, probeCopy, dropLocal, insertStatement, rewriteCopy,
} = require('./writeThroughRows');

/**
 * Run `op` over `items` one by one, honouring `collect` (see the header).
 * @returns {{ results: Array<{index, ...}>, errors: Array<{index, error}>, stopped: boolean }}
 */
async function perRow(items, op, { collect }) {
    const results = [];
    const errors = [];
    let stopped = false;
    for (let i = 0; i < items.length; i += 1) {
        try {
            results.push({ index: i, ...(await op(items[i], i)) });
        } catch (e) {
            if (!collect) throw e;
            errors.push({ index: i, error: e });
            if (e && e.errorClass === UNAVAILABLE) { stopped = true; break; }
        }
    }
    return { results, errors, stopped };
}

/** Wire every item, collecting or throwing per `collect`. */
function wireAll(w, ctx, items, pick, { collect }) {
    const wired = [];
    const errors = [];
    for (let i = 0; i < items.length; i += 1) {
        try {
            wired.push({ index: i, item: items[i], wire: w.adapter.toWire(ctx, pick(items[i])) });
        } catch (e) {
            if (!collect) throw e;
            errors.push({ index: i, error: e });
        }
    }
    return { wired, errors };
}

const changedOf = (results) => results.reduce((n, x) => n + (Number(x.changes) || 0), 0);

/** @returns {{ inserted: Array<{index,id,row}>, errors, stopped }} */
async function insertRows(w, ctx, list, { collect = false } = {}) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'create');
    const items = Array.isArray(list) ? list : [];
    if (typeof w.adapter.sourceInsertMany !== 'function') {
        const r = await perRow(items, (values) => w.insertRow(ctx, values), { collect });
        return { inserted: r.results, errors: r.errors, stopped: r.stopped };
    }
    const { wired, errors } = wireAll(w, ctx, items, v => v, { collect });
    if (!wired.length) return { inserted: [], errors, stopped: false };
    const api = await w.adapter.apiFor(ctx);
    // ONE source write for the whole list; a refusal is the whole batch's.
    const raws = await w.adapter.sourceInsertMany(api, ctx, wired.map(x => x.wire));
    const inserted = [];
    const stmts = [];
    for (let i = 0; i < wired.length; i += 1) {
        const { id, values: local } = await w.adapter.localValuesFor(ctx, raws[i], {});
        stmts.push(insertStatement(ctx, id, local));
        inserted.push({ index: wired[i].index, id });
    }
    for (let i = 0; i < stmts.length; i += WRITE_CHUNK) {
        await datatableDbStore.batch(ctx.scopeKey, ctx.scopeKey, stmts.slice(i, i + WRITE_CHUNK).map(s => ({ sql: s.sql, params: s.params })));
    }
    await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, inserted.length);
    for (const r of inserted) r.row = await readBack(ctx, r.id);
    return { inserted, errors, stopped: false };
}

/**
 * @param {Array<{ id:string, values:object, expectedUpdatedAt?:string }>} list
 * @returns {{ changed:number, results: Array<{index, changes, row}>, errors, stopped }}
 */
async function updateRows(w, ctx, list, { collect = false } = {}) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'update');
    const items = Array.isArray(list) ? list : [];
    if (typeof w.adapter.sourceUpdateMany !== 'function') {
        const r = await perRow(items, (it) => w.updateRow(ctx, it.id, it.values, { expectedUpdatedAt: it.expectedUpdatedAt || null }), { collect });
        return { changed: changedOf(r.results), results: r.results, errors: r.errors, stopped: r.stopped };
    }
    for (const it of items) assertRowId(it && it.id);
    const { wired, errors } = wireAll(w, ctx, items, it => it.values, { collect });
    const results = [];
    // The copy first, per row, with the caller's rights — exactly as the
    // single form: not theirs → 0/null, stale token → 0/row, no source call.
    const toSource = [];
    for (const x of wired) {
        const current = await probeCopy(ctx, x.item.id, 'update');
        if (!current) { results.push({ index: x.index, changes: 0, row: null }); continue; }
        if (x.item.expectedUpdatedAt && !sameInstant(current.updated_at, x.item.expectedUpdatedAt)) {
            results.push({ index: x.index, changes: 0, row: current });
            continue;
        }
        toSource.push(x);
    }
    if (toSource.length) {
        const api = await w.adapter.apiFor(ctx);
        const raws = await w.adapter.sourceUpdateMany(api, ctx, toSource.map(x => ({ rowId: x.item.id, wire: x.wire })));
        for (let i = 0; i < toSource.length; i += 1) {
            const x = toSource[i];
            if (raws[i] === null || raws[i] === undefined) {
                await dropLocal(ctx, x.item.id);
                results.push({ index: x.index, changes: 0, row: null });
                continue;
            }
            results.push({ index: x.index, ...(await rewriteCopy(w, ctx, x.item.id, raws[i])) });
        }
    }
    results.sort((a, b) => a.index - b.index);
    return { changed: changedOf(results), results, errors, stopped: false };
}

/** @returns {{ changed:number, results: Array<{index, changes}>, errors, stopped }} */
async function deleteRows(w, ctx, ids, { collect = false } = {}) {
    assertCtx(w, ctx);
    assertEditor(w, ctx, 'delete');
    const items = Array.isArray(ids) ? ids : [];
    if (typeof w.adapter.sourceDeleteMany !== 'function') {
        const r = await perRow(items, (id) => w.deleteRow(ctx, id), { collect });
        return { changed: changedOf(r.results), results: r.results, errors: r.errors, stopped: r.stopped };
    }
    for (const id of items) assertRowId(id);
    const results = [];
    const present = [];
    for (let i = 0; i < items.length; i += 1) {
        if (await probeCopy(ctx, items[i], 'delete')) present.push({ index: i, id: items[i] });
        else results.push({ index: i, changes: 0 });
    }
    if (present.length) {
        const api = await w.adapter.apiFor(ctx);
        await w.adapter.sourceDeleteMany(api, ctx, present.map(p => p.id));
        const stmts = present.map(p => queryCompiler.compileDelete(ctx.tableMeta, p.id, ownerFilter(ctx, 'delete'), PG));
        let gone = 0;
        for (let i = 0; i < stmts.length; i += WRITE_CHUNK) {
            const out = await datatableDbStore.batch(ctx.scopeKey, ctx.scopeKey, stmts.slice(i, i + WRITE_CHUNK).map(s => ({ sql: s.sql, params: s.params })));
            (out || []).forEach((r, j) => {
                const changes = Number(r && r.changes) || 0;
                gone += changes;
                results.push({ index: present[i + j].index, changes });
            });
        }
        if (gone) await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, -gone);
    }
    results.sort((a, b) => a.index - b.index);
    return { changed: changedOf(results), results, errors: [], stopped: false };
}

module.exports = { insertRows, updateRows, deleteRows };
