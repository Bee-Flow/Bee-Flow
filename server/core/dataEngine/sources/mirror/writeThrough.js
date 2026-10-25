// @typecheck noImplicitAny
/**
 * A row changed IN BEE FLOW → the source first, then the copy — the same
 * contract for every kind, with the adapter supplying only what its source
 * understands (the wire shape of a row, the calls that write it, how to read
 * the answer back).
 *
 * Every write site that can touch a datatable's rows (the Studio routes, the
 * automation `datatable` step, App Studio's record actions, the webpage bridge)
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
 * than one. Without it the first refusal throws — the automation-step contract,
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
 *
 * The single-row writes are in ./writeThroughRows.js, the batch forms in
 * ./writeThroughBatch.js; this file assembles them per adapter.
 */

'use strict';

// The single rows and the shared checks; the batch forms.
const rows = require('./writeThroughRows');
const batch = require('./writeThroughBatch');

const { UNAVAILABLE, sameInstant } = rows;

/** @typedef {import('./writeThroughRows').WriteCtx} WriteCtx */

/**
 * Build the context every write site hands over, from what it already holds.
 * @param {Omit<WriteCtx, 'viewerId'> & { viewerId?: string | null }} parts
 * @returns {WriteCtx}
 */
function contextOf({ table, scope, scopeKey, tableMeta, grade, viewerId }) {
    return { table, scope, scopeKey, tableMeta, grade, viewerId: viewerId || null };
}

/** @param {import('./writeThroughRows').WriteAdapter} adapter */
function makeWriteThrough(adapter) {
    if (!adapter || typeof adapter.toWire !== 'function' || typeof adapter.apiFor !== 'function') {
        throw new Error('makeWriteThrough: an adapter with toWire() and apiFor() is required');
    }
    /** @type {import('./writeThroughRows').Writer} */
    const w = {
        adapter,
        Err: adapter.Err,
        notFound: adapter.notFoundCodes instanceof Set ? adapter.notFoundCodes : new Set(adapter.notFoundCodes || []),
    };
    w.insertRow = (ctx, values) => rows.insertRow(w, ctx, values);
    w.updateRow = (ctx, rowId, values, opts) => rows.updateRow(w, ctx, rowId, values, opts);
    w.deleteRow = (ctx, rowId) => rows.deleteRow(w, ctx, rowId);
    return {
        insertRow: w.insertRow,
        updateRow: w.updateRow,
        deleteRow: w.deleteRow,
        /** @param {WriteCtx} ctx @param {unknown[]} list @param {{ collect?: boolean }} [opts] */
        insertRows: (ctx, list, opts) => batch.insertRows(w, ctx, list, opts),
        /** @param {WriteCtx} ctx @param {Parameters<typeof batch.updateRows>[2]} list @param {{ collect?: boolean }} [opts] */
        updateRows: (ctx, list, opts) => batch.updateRows(w, ctx, list, opts),
        /** @param {WriteCtx} ctx @param {string[]} ids @param {{ collect?: boolean }} [opts] */
        deleteRows: (ctx, ids, opts) => batch.deleteRows(w, ctx, ids, opts),
        contextOf,
    };
}

module.exports = { makeWriteThrough, sameInstant, UNAVAILABLE };
