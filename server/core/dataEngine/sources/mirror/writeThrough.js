/**
 * A row changed IN BEE FLOW → the source first, then the copy — the same
 * contract for every kind, with the adapter supplying only what its source
 * understands (the wire shape of a row, the calls that write it, how to read
 * the answer back).
 *
 * Every write site that can touch a datatable's rows (the Studio routes, the
 * routine `datatable` step, App Studio's record actions, the webpage bridge)
 * branches here for a mirror, with one context:
 *
 *   ctx = { table, scope, scopeKey, tableMeta (with its access block), grade, viewerId }
 *
 * and gets back the same shapes it would have produced itself, so its answer
 * to the client does not change:
 *   insertRow → { id, row }               (row read back with the caller's own filter)
 *   updateRow → { changes: 0|1, row }     (0 + row  = somebody changed it: row_conflict;
 *                                          0 + null = not there / not yours)
 *   deleteRow → { changes: 0|1 }
 *
 * ── THE ORDER ───────────────────────────────────────────────────────
 * The caller's rights are re-asserted (grade + assertCanWrite — belt and
 * braces, the caller already did), then the MIRROR is probed with the
 * caller's own access filter: a row the caller may not see is "not found"
 * BEFORE the source is asked anything, and a stale `expectedUpdatedAt` is a
 * conflict before the source is asked anything. Only then does the change go
 * to the source — as the LINKER, not the caller — and only what the source
 * answered is written into the copy. The source refusing means NOTHING
 * changed on either side, which is the sentence the client shows.
 *
 * ── BATCH FORMS ─────────────────────────────────────────────────────
 * `insertRows/updateRows/deleteRows` take a list. A source with a batch call
 * of its own (a file that is rewritten once — `sourceInsertMany` and friends
 * on the adapter) gets ONE source write for the whole list; a source without
 * one gets the per-row loop. Either way the caller sees one answer per item.
 * With `collect: true` a per-row refusal is reported beside its index and
 * the loop goes on — the bulk-import contract — stopping only when the
 * source is unreachable (`errorClass === 'datatable_source_unavailable'`),
 * because N copies of "could not be reached" tell the importer nothing more
 * than one. Without it the first refusal throws — the routine-step contract,
 * where a half-done step must be red.
 *
 * ── WHAT CANNOT BE WRITTEN ──────────────────────────────────────────
 * That is the adapter's `toWire`: a derived column is refused there with
 * `derived_column`, system columns are dropped, an unknown column is the
 * same CompileError the local path raises.
 *
 * ── THE ADAPTER ─────────────────────────────────────────────────────
 *   { KIND, isMirror(table), Err (the kind's SourceError class), forbiddenCode,
 *     notFoundCodes: Set<string>,     "the source no longer has it" → the copy loses it too
 *     toWire(ctx, values) → wire,
 *     apiFor(ctx) → Promise<api>,     the linker's client (resolved per call, memoised inside)
 *     sourceInsert(api, ctx, wire) → raw,
 *     sourceUpdate(api, ctx, rowId, wire) → raw,
 *     sourceDelete(api, ctx, rowId),
 *     sourceInsertMany?(api, ctx, wires) → raw[],           aligned with `wires`
 *     sourceUpdateMany?(api, ctx, [{ rowId, wire }]) → raw[], null = not found at the source
 *     sourceDeleteMany?(api, ctx, rowIds),
 *     localValuesFor(ctx, raw, { rowId? }) → Promise<{ id, values }> }
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const accessFilter = require('../../accessFilter');
const { gradeAtLeast } = require('../../../../auth/datatableAccess');
const { isSourceError } = require('./errors');
const { PG, WRITE_CHUNK } = require('./constants');

const UNAVAILABLE = 'datatable_source_unavailable';

function makeWriteThrough(adapter) {
    if (!adapter || typeof adapter.toWire !== 'function' || typeof adapter.apiFor !== 'function') {
        throw new Error('makeWriteThrough: an adapter with toWire() and apiFor() is required');
    }
    const Err = adapter.Err;
    const notFound = adapter.notFoundCodes instanceof Set ? adapter.notFoundCodes : new Set(adapter.notFoundCodes || []);

    function assertCtx(ctx) {
        if (!ctx || !ctx.table || !adapter.isMirror(ctx.table) || !ctx.table.source) {
            throw new Error(`writeThrough: not a ${adapter.KIND} mirror`);
        }
        if (!ctx.tableMeta || !ctx.tableMeta.access) throw new Error('writeThrough: tableMeta with access is required');
        if (!ctx.scope || !ctx.scopeKey) throw new Error('writeThrough: scope and scopeKey are required');
    }

    function callerFilter(ctx, action) {
        return accessFilter.compileAccessFilter(ctx.tableMeta, ctx.grade, { id: ctx.viewerId || null }, action, PG);
    }

    function ownerFilter(ctx, action) {
        return accessFilter.compileAccessFilter(ctx.tableMeta, 'owner', { id: null }, action, PG);
    }

    function assertEditor(ctx, action) {
        if (!gradeAtLeast(ctx.grade, 'editor')) {
            throw new Err(403, adapter.forbiddenCode, 'This needs editor access to the datatable', { errorClass: 'datatable_forbidden' });
        }
        accessFilter.assertCanWrite(ctx.tableMeta, ctx.grade, action);
    }

    function assertRowId(rowId) {
        if (typeof rowId !== 'string' || !rowId) throw new queryCompiler.CompileError('record id is required');
    }

    function isNotFound(e) {
        return isSourceError(e) && notFound.has(e.code);
    }

    async function readBack(ctx, id) {
        const probe = queryCompiler.compileGetById(ctx.tableMeta, id, callerFilter(ctx, 'read'), PG);
        const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, probe.sql, probe.params);
        return (found.rows || [])[0] || null;
    }

    /** The copy row the caller may act on, or null. */
    async function probeCopy(ctx, rowId, action) {
        const probe = queryCompiler.compileGetById(ctx.tableMeta, rowId, callerFilter(ctx, action), PG);
        const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, probe.sql, probe.params);
        return (found.rows || [])[0] || null;
    }

    /** The source no longer has it: neither should the copy. */
    async function dropLocal(ctx, rowId) {
        const del = queryCompiler.compileDelete(ctx.tableMeta, rowId, ownerFilter(ctx, 'delete'), PG);
        const gone = await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, del.sql, del.params);
        const changes = Number(gone && gone.changes) || 0;
        if (changes) await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, -changes);
        return changes;
    }

    function insertStatement(ctx, id, local) {
        return queryCompiler.compileInsert(ctx.tableMeta, local, {
            ...PG, id, createdBy: ctx.viewerId || ctx.table.source.linkedByUserId || null, orgId: ctx.table.organizationId || null,
        });
    }

    // ── single rows ────────────────────────────────────────────────────

    async function insertRow(ctx, values) {
        assertCtx(ctx);
        assertEditor(ctx, 'create');
        const wire = adapter.toWire(ctx, values);
        const api = await adapter.apiFor(ctx);
        const raw = await adapter.sourceInsert(api, ctx, wire);
        const { id, values: local } = await adapter.localValuesFor(ctx, raw, {});
        const ins = insertStatement(ctx, id, local);
        await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, ins.sql, ins.params);
        await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, 1);
        return { id, row: await readBack(ctx, id) };
    }

    async function updateRow(ctx, rowId, values, { expectedUpdatedAt = null } = {}) {
        assertCtx(ctx);
        assertEditor(ctx, 'update');
        assertRowId(rowId);
        const wire = adapter.toWire(ctx, values);

        // The copy first, with the CALLER's rights: not theirs → not found; stale
        // token → conflict. Neither asks the source anything.
        const current = await probeCopy(ctx, rowId, 'update');
        if (!current) return { changes: 0, row: null };
        if (expectedUpdatedAt && !sameInstant(current.updated_at, expectedUpdatedAt)) {
            return { changes: 0, row: current };
        }

        const api = await adapter.apiFor(ctx);
        let raw;
        try {
            raw = await adapter.sourceUpdate(api, ctx, rowId, wire);
        } catch (e) {
            if (isNotFound(e)) {
                await dropLocal(ctx, rowId);
                return { changes: 0, row: null };
            }
            throw e;
        }
        return rewriteCopy(ctx, rowId, raw);
    }

    /** What the source answered is the truth — written without a token. */
    async function rewriteCopy(ctx, rowId, raw) {
        const { values: local } = await adapter.localValuesFor(ctx, raw, { rowId });
        const upd = queryCompiler.compileUpdate(ctx.tableMeta, rowId, local, ownerFilter(ctx, 'update'), PG);
        await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, upd.sql, upd.params);
        await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, 0);
        return { changes: 1, row: await readBack(ctx, rowId) };
    }

    async function deleteRow(ctx, rowId) {
        assertCtx(ctx);
        assertEditor(ctx, 'delete');
        assertRowId(rowId);
        if (!await probeCopy(ctx, rowId, 'delete')) return { changes: 0 };

        const api = await adapter.apiFor(ctx);
        try {
            await adapter.sourceDelete(api, ctx, rowId);
        } catch (e) {
            // Already gone at the source counts as deleted.
            if (!isNotFound(e)) throw e;
        }
        const del = queryCompiler.compileDelete(ctx.tableMeta, rowId, ownerFilter(ctx, 'delete'), PG);
        const out = await datatableDbStore.exec(ctx.scopeKey, ctx.scopeKey, del.sql, del.params);
        const changes = Number(out && out.changes) || 0;
        if (changes) await datatableStore.bumpAfterWrite(ctx.table.id, ctx.scope, -changes);
        return { changes };
    }

    // ── batches ────────────────────────────────────────────────────────

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
    function wireAll(ctx, items, pick, { collect }) {
        const wired = [];
        const errors = [];
        for (let i = 0; i < items.length; i += 1) {
            try {
                wired.push({ index: i, item: items[i], wire: adapter.toWire(ctx, pick(items[i])) });
            } catch (e) {
                if (!collect) throw e;
                errors.push({ index: i, error: e });
            }
        }
        return { wired, errors };
    }

    /** @returns {{ inserted: Array<{index,id,row}>, errors, stopped }} */
    async function insertRows(ctx, list, { collect = false } = {}) {
        assertCtx(ctx);
        assertEditor(ctx, 'create');
        const items = Array.isArray(list) ? list : [];
        if (typeof adapter.sourceInsertMany !== 'function') {
            const r = await perRow(items, (values) => insertRow(ctx, values), { collect });
            return { inserted: r.results, errors: r.errors, stopped: r.stopped };
        }
        const { wired, errors } = wireAll(ctx, items, v => v, { collect });
        if (!wired.length) return { inserted: [], errors, stopped: false };
        const api = await adapter.apiFor(ctx);
        // ONE source write for the whole list; a refusal is the whole batch's.
        const raws = await adapter.sourceInsertMany(api, ctx, wired.map(w => w.wire));
        const inserted = [];
        const stmts = [];
        for (let i = 0; i < wired.length; i += 1) {
            const { id, values: local } = await adapter.localValuesFor(ctx, raws[i], {});
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
    async function updateRows(ctx, list, { collect = false } = {}) {
        assertCtx(ctx);
        assertEditor(ctx, 'update');
        const items = Array.isArray(list) ? list : [];
        if (typeof adapter.sourceUpdateMany !== 'function') {
            const r = await perRow(items, (it) => updateRow(ctx, it.id, it.values, { expectedUpdatedAt: it.expectedUpdatedAt || null }), { collect });
            return { changed: r.results.reduce((n, x) => n + (Number(x.changes) || 0), 0), results: r.results, errors: r.errors, stopped: r.stopped };
        }
        for (const it of items) assertRowId(it && it.id);
        const { wired, errors } = wireAll(ctx, items, it => it.values, { collect });
        const results = [];
        // The copy first, per row, with the caller's rights — exactly as the
        // single form: not theirs → 0/null, stale token → 0/row, no source call.
        const toSource = [];
        for (const w of wired) {
            const current = await probeCopy(ctx, w.item.id, 'update');
            if (!current) { results.push({ index: w.index, changes: 0, row: null }); continue; }
            if (w.item.expectedUpdatedAt && !sameInstant(current.updated_at, w.item.expectedUpdatedAt)) {
                results.push({ index: w.index, changes: 0, row: current });
                continue;
            }
            toSource.push(w);
        }
        if (toSource.length) {
            const api = await adapter.apiFor(ctx);
            const raws = await adapter.sourceUpdateMany(api, ctx, toSource.map(w => ({ rowId: w.item.id, wire: w.wire })));
            for (let i = 0; i < toSource.length; i += 1) {
                const w = toSource[i];
                if (raws[i] === null || raws[i] === undefined) {
                    await dropLocal(ctx, w.item.id);
                    results.push({ index: w.index, changes: 0, row: null });
                    continue;
                }
                results.push({ index: w.index, ...(await rewriteCopy(ctx, w.item.id, raws[i])) });
            }
        }
        results.sort((a, b) => a.index - b.index);
        return { changed: results.reduce((n, x) => n + (Number(x.changes) || 0), 0), results, errors, stopped: false };
    }

    /** @returns {{ changed:number, results: Array<{index, changes}>, errors, stopped }} */
    async function deleteRows(ctx, ids, { collect = false } = {}) {
        assertCtx(ctx);
        assertEditor(ctx, 'delete');
        const items = Array.isArray(ids) ? ids : [];
        if (typeof adapter.sourceDeleteMany !== 'function') {
            const r = await perRow(items, (id) => deleteRow(ctx, id), { collect });
            return { changed: r.results.reduce((n, x) => n + (Number(x.changes) || 0), 0), results: r.results, errors: r.errors, stopped: r.stopped };
        }
        for (const id of items) assertRowId(id);
        const results = [];
        const present = [];
        for (let i = 0; i < items.length; i += 1) {
            if (await probeCopy(ctx, items[i], 'delete')) present.push({ index: i, id: items[i] });
            else results.push({ index: i, changes: 0 });
        }
        if (present.length) {
            const api = await adapter.apiFor(ctx);
            await adapter.sourceDeleteMany(api, ctx, present.map(p => p.id));
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
        return { changed: results.reduce((n, x) => n + (Number(x.changes) || 0), 0), results, errors: [], stopped: false };
    }

    /** Build the context every write site hands over, from what it already holds. */
    function contextOf({ table, scope, scopeKey, tableMeta, grade, viewerId }) {
        return { table, scope, scopeKey, tableMeta, grade, viewerId: viewerId || null };
    }

    return { insertRow, updateRow, deleteRow, insertRows, updateRows, deleteRows, contextOf };
}

function sameInstant(a, b) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
    return String(a) === String(b);
}

module.exports = { makeWriteThrough, sameInstant, UNAVAILABLE };
