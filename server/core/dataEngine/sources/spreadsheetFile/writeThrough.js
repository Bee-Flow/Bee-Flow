/**
 * A row changed IN BEE FLOW → the FILE first, then the copy.
 *
 * The contract — the caller's own probe of the copy BEFORE the storage is
 * asked, the storage as the LINKER, only what the storage now holds written
 * into the copy, a refusal changing nothing on either side — is every
 * mirror's and lives in ../mirror/writeThrough.makeWriteThrough. What is a
 * FILE's is here, and it is more than a Nextcloud table needs, because a
 * file has no row API: every write is "find the row in the sheet, change
 * the sheet, put the sheet back", and three things can go wrong in between
 * that a table with row ids never sees.
 *
 * ── THE ORDER, INSIDE THE STORAGE HALF ──────────────────────────────
 *   0. refuse     `source.write.mode === 'none'` (an .ods, a file the linker
 *                 does not own without the opt-in, no permission) → 409
 *                 spreadsheet_write_unsupported with the reason, before any
 *                 probe — and before the context is even checked, so a
 *                 read-only file is refused the same way by every caller
 *   1. lock       one writer per `provider|fileId` in this process
 *                 (cache.withLock): two tabs of one workbook are two
 *                 mirrors, two editors on one table are two requests, and
 *                 the loser of a race on one etag would lose its rewrite
 *   2. probe      the file's marker vs the one the copy was synced from
 *                 (`sync_state.marker`, read FRESH — a write a second ago
 *                 moved it). Moved → the copy is behind → mark it stale,
 *                 kick a pass, answer 409 spreadsheet_conflict: "being
 *                 refreshed, try again". Nothing was written.
 *   3. locate     the target row in the sheet as it is now (through the
 *                 download cache — the pass that verified this marker
 *                 parsed the same bytes): key mode by the key's position,
 *                 row mode by `r<n>` → n — and VERIFY it: in row mode the
 *                 sheet row is read through the codec and compared with
 *                 the copy, because a marker is a promise the storage
 *                 makes, not one we can check, and writing the wrong row
 *                 of someone's file is the worst outcome there is
 *   4. write      per `source.write.mode`:
 *                   sheets_api      Sheets cells (updateCells / append /
 *                                   deleteDimension), Drive version guard
 *                   graph_workbook  Graph workbook ranges in one session
 *                   exceljs_put     bytes → exceljs in place → PUT If-Match
 *                   csv_put         bytes → byte-faithful rewrite → PUT
 *                 A batch is ONE download → every op → ONE upload. A 412
 *                 on that upload (a second writer beat us) re-downloads,
 *                 re-locates, re-verifies and retries ONCE; then it is a
 *                 conflict. A cells write that fails half way leaves the
 *                 copy behind for the rows already written: stale + kick.
 *   5. record     the new marker and content hash go into the sync state
 *                 (patchSyncState) so the next pulse's probe reads
 *                 "unchanged" — our own write never costs a download —
 *                 and, when a pass was running while we wrote (it read
 *                 the file BEFORE our write and would finish with stale
 *                 rows), or when the write was a retry over someone else's
 *                 change, `staleReason:'write'` so the next tick re-reads.
 *                 The hash is the pass's own (reading.contentHashOf: row
 *                 numbers included in row mode), or a write would never
 *                 read "unchanged" again. Sibling mirrors of the same file
 *                 (other tabs) whose recorded marker was the one we
 *                 verified get the new one too: our write did not touch
 *                 their tab.
 * Then the shared half rewrites the copy with the owner filter and bumps
 * the counters, exactly as for Nextcloud.
 *
 * ── WHAT A CELL API RECALCULATES ────────────────────────────────────
 * Sheets and the Graph workbook recompute formulas as part of the write,
 * and the post state a cells write computes in memory (applyInMemory)
 * still holds the cached results of the read BEFORE it. When the sheet
 * has formula columns the rows just written are READ BACK (api.cells
 * .readRow) and spliced into that state, so the copy and the answer show
 * what the sheet now computes for them; a cell API without readRow gets
 * the copy flagged behind instead (the next pass re-reads). Formulas in
 * OTHER rows that depend on the edited cell (a running total) are picked
 * up by the next pass that finds the marker moved. Byte modes need
 * neither: exceljs and the csv rewrite recalculate nothing, so the
 * in-memory parse IS the file.
 *
 * ── WHAT IS DIFFERENT AFTER THE COPY IS WRITTEN ─────────────────────
 * The KEY COLUMN edited: the row's id IS its key, so the copy row moves to
 * the new id — compileDelete old + compileInsert new in one batch — and
 * the answer carries `id: newId` (an automation holding the old id is told).
 * A ROW-MODE DELETE shifts every row number under it: after the copy
 * delete the mirror is marked stale and a pass runs at once (`syncRows({
 * reason:'write' })`, ≤ 10 k rows — the mark is what makes it read past
 * the marker record() just wrote) so `r<n>` means the same row on both
 * sides again, and the answer carries `renumbered: true` so an open grid
 * reloads. When a pass is already running — one that read the file
 * BEFORE our PUT — its claim is NOT taken over (two passes writing one
 * copy at once could leave the older bytes in it under the new marker):
 * the stale mark, set after that pass's claim, survives its finish, a
 * kick is scheduled, and the answer says `renumbered: false` — the pass
 * in flight renumbers shortly and the grid's pulse picks it up. An append
 * that a cell API lands INSIDE the block (a provider that ignored
 * `afterRow`) shifted the rows under it the same way: the copy is
 * flagged behind for the next pass.
 *
 * ── WHAT CANNOT BE WRITTEN ──────────────────────────────────────────
 * A derived column (a match relation's `_ref`) and a FORMULA column (the
 * file's cached result) are refused with 400 derived_column — by the
 * column map first (toWire), and by the file itself for a formula the map
 * does not know yet (exceljs reports the cells it skipped; nothing is
 * uploaded then); a value the column's declared type cannot hold is
 * refused with 422 naming the column (cells.writeCell); a blank key with
 * 422 key_missing; a key another row already has with 409 key_duplicate
 * — the sheet would keep both rows and the mirror only the first.
 */

'use strict';

const { makeWriteThrough } = require('../mirror/writeThrough');
const { KIND, isMirror } = require('./index');
const { SpreadsheetSourceError, providerName } = require('./errors');
const identity = require('./identity');
const log = require('../../../../telemetry/log');
const { ROW_MISSING, currentColumns, sameValue, writeFile, scratchOf } = require('./writeThroughFile');
const { toWire, localValuesFor, keyMoveOf, moveCopy, renumber } = require('./writeThroughMove');

function linkerAuth() { return require('./linkerAuth'); }

// ─── Refusals ───────────────────────────────────────────────────────────

const READ_ONLY_SENTENCE = Object.freeze({
    xls: 'A .xls file cannot be edited from here — save it as .xlsx to write rows back.',
    xlsm: 'A .xlsm file cannot be edited from here (its macros would be lost) — save a copy as .xlsx to write rows back.',
    ods: 'An .ods file cannot be edited from here — save it as .xlsx to write rows back.',
    format: 'Files of this type cannot be edited from here.',
    not_owned: 'This file belongs to someone else — rows are not written into it unless the account that linked it opted in.',
    no_permission: 'The account that linked this table may not write to this file.',
});

/** Step 0: a file that cannot take rows is refused before anything is asked of anyone. */
function refuseIfReadOnly(ctx) {
    const source = (ctx && ctx.table && ctx.table.source) || {};
    const write = source.write || {};
    let reason = null;
    if (!write.mode || write.mode === 'none') reason = write.reason || 'not_writable';
    else if (source.owned === false && write.sharedOptIn !== true) reason = 'not_owned';
    if (!reason) return;
    const sentence = READ_ONLY_SENTENCE[reason] || `Rows cannot be written into ${providerName(source.provider)} for this table.`;
    throw new SpreadsheetSourceError(409, 'spreadsheet_write_unsupported', sentence, { reason });
}

// ─── The wire: values → typed cells ─────────────────────────────────────

// ─── Opening the file for a write ───────────────────────────────────────

// ─── Locating and verifying rows ────────────────────────────────────────

// ─── Writing, per mode ──────────────────────────────────────────────────

// ─── The adapter the shared half drives ─────────────────────────────────

async function linkerApi(ctx) {
    const linker = await linkerAuth().resolveLinker(ctx.table.source, { orgId: ctx.table.organizationId || null, write: true });
    return linker.api;
}

const adapter = {
    KIND,
    isMirror,
    Err: SpreadsheetSourceError,
    forbiddenCode: 'spreadsheet_forbidden',
    notFoundCodes: new Set([ROW_MISSING]),
    toWire,
    apiFor: linkerApi,
    async sourceInsert(api, ctx, wire) {
        const [raw] = await writeFile(api, ctx, [{ kind: 'append', wire }]);
        return raw;
    },
    async sourceUpdate(api, ctx, rowId, wire) {
        const [raw] = await writeFile(api, ctx, [{ kind: 'update', rowId, wire }]);
        scratchOf(ctx).raws.set(rowId, raw);
        return raw;
    },
    async sourceDelete(api, ctx, rowId) {
        await writeFile(api, ctx, [{ kind: 'delete', rowId }]);
    },
    async sourceInsertMany(api, ctx, wires) {
        return writeFile(api, ctx, wires.map(wire => ({ kind: 'append', wire })));
    },
    async sourceUpdateMany(api, ctx, items) {
        const raws = await writeFile(api, ctx, items.map(({ rowId, wire }) => ({ kind: 'update', rowId, wire, tolerateMissing: true })));
        items.forEach(({ rowId }, i) => { if (raws[i]) scratchOf(ctx).raws.set(rowId, raws[i]); });
        return raws;
    },
    async sourceDeleteMany(api, ctx, rowIds) {
        await writeFile(api, ctx, rowIds.map(rowId => ({ kind: 'delete', rowId, tolerateMissing: true })));
    },
    localValuesFor,
};

const shared = makeWriteThrough(adapter);

// ─── The wrapper: what happens after the copy is written ────────────────

function effectiveMode(ctx) {
    return scratchOf(ctx).mode || identity.identityOf(ctx.table.source).mode;
}

/** A fresh context per call: the scratch must not outlive the write. */
function fresh(ctx) {
    return ctx && typeof ctx === 'object' ? { ...ctx } : ctx;
}

async function insertRow(ctx, values) {
    refuseIfReadOnly(ctx);
    return shared.insertRow(fresh(ctx), values);
}

async function updateRow(ctx, rowId, values, opts = {}) {
    refuseIfReadOnly(ctx);
    const c = fresh(ctx);
    const newId = keyMoveOf(c, rowId, values);
    const r = await shared.updateRow(c, rowId, values, opts);
    // The key column vanished from the sheet: the row was addressed by
    // number this time (openFile), and a number does not move.
    if (!newId || r.changes !== 1 || effectiveMode(c) !== 'key') return r;
    return moveCopy(c, rowId, newId, r);
}

async function deleteRow(ctx, rowId) {
    refuseIfReadOnly(ctx);
    const c = fresh(ctx);
    const r = await shared.deleteRow(c, rowId);
    if (!r.changes || effectiveMode(c) !== 'row') return r;
    return { ...r, renumbered: await renumber(c) };
}

async function insertRows(ctx, list, opts = {}) {
    refuseIfReadOnly(ctx);
    return shared.insertRows(fresh(ctx), list, opts);
}

async function updateRows(ctx, list, opts = {}) {
    refuseIfReadOnly(ctx);
    const c = fresh(ctx);
    const items = Array.isArray(list) ? list : [];
    const moves = new Map();
    if (c && c.table && c.table.source && c.tableMeta && identity.identityOf(c.table.source).mode === 'key') {
        for (const it of items) {
            try {
                const newId = it && keyMoveOf(c, it.id, it.values);
                if (newId) moves.set(it.id, newId);
            } catch (err) { log.debug('the shared half reports (or collects) the refusal itself', err); }
        }
    }
    const out = await shared.updateRows(c, items, opts);
    if (!moves.size || effectiveMode(c) !== 'key') return out;
    for (const res of out.results) {
        const it = items[res.index];
        const newId = it && moves.get(it.id);
        if (!newId || res.changes !== 1) continue;
        const moved = await moveCopy(c, it.id, newId, res);
        res.id = moved.id;
        res.row = moved.row;
    }
    return out;
}

async function deleteRows(ctx, ids, opts = {}) {
    refuseIfReadOnly(ctx);
    const c = fresh(ctx);
    const out = await shared.deleteRows(c, ids, opts);
    if (!out.changed || effectiveMode(c) !== 'row') return out;
    return { ...out, renumbered: await renumber(c) };
}

module.exports = {
    insertRow, updateRow, deleteRow, insertRows, updateRows, deleteRows,
    contextOf: shared.contextOf,
    // exported for tests
    toWire, refuseIfReadOnly, sameValue, currentColumns, ROW_MISSING,
};
