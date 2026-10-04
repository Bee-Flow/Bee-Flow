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

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const accessFilter = require('../../accessFilter');
const { SYSTEM_COLUMNS } = require('../../dataModel/vocabulary');
const { makeWriteThrough } = require('../mirror/writeThrough');
const { buildRelationIndexes } = require('../mirror/relations');
const { ownerFilter } = require('../mirror/access');
const { PG, ENGINE_READ_CAP, DEFAULT_ROW_CAP } = require('../mirror/constants');
const { KIND, isMirror } = require('./index');
const { SpreadsheetSourceError, providerName } = require('./errors');
const { writeCell, readCell, isoToSerial, isBlank } = require('./cells');
const columns = require('./columns');
const identity = require('./identity');
const { rowFromSheet, fieldsByIdOf } = require('./rows');
const reading = require('./reading');
const cache = require('./cache');
const formats = require('./formats');

const CELLS_MODES = new Set(['sheets_api', 'graph_workbook']);
const BYTE_MODES = new Set(['exceljs_put', 'csv_put']);
/**
 * Internal: "this row is not in the sheet". The shared half turns it into
 * "drop the copy" (update) or "counts as deleted" (delete); it never reaches
 * a client. The FILE being gone is a different thing (spreadsheet_not_found
 * from the probe) and propagates as the error it is.
 */
const ROW_MISSING = 'spreadsheet_row_missing';
/** Per-call scratch the storage half leaves for the wrapper (post-write rows, the effective identity mode). */
const SCRATCH = Symbol('spreadsheetWrite');

/** Lazily: sync.js requires the adapter, whose writeThrough getter requires this file. */
function syncModule() { return require('./sync'); }
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

function derivedColumn(field, key, entry) {
    const name = field.name || key;
    const why = entry && entry.formula
        ? `"${name}" holds a formula in the file and is read-only here — change the cells it is computed from.`
        : `"${name}" is filled in from a relation and cannot be set directly — change the column it is derived from.`;
    return new SpreadsheetSourceError(400, 'derived_column', why);
}

// ─── The wire: values → typed cells ─────────────────────────────────────

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

// ─── Opening the file for a write ───────────────────────────────────────

function lockKeyOf(source) {
    return cache.lockKeyOf(source.provider, reading.fileIdOf({ provider: source.provider, ...(source.file || {}), fileId: (source.file || {}).id }));
}

function refOf(source) {
    const file = source.file || {};
    return { provider: source.provider, fileId: file.id || null, driveId: file.driveId || null, path: file.path || null, name: file.name || null };
}

/** The mapped columns as they sit in THIS header: fieldId → { col, entry } (a vanished column is simply absent). */
function currentColumns(read, source) {
    const byHash = new Map(columns.describeHeader(read.header).map(d => [d.headerHash, d.col]));
    const out = new Map();
    for (const [fieldId, entry] of Object.entries(source.columnMap || {})) {
        if (!entry || entry.derived) continue;
        const hash = entry.headerHash || (columns.parseFieldId(fieldId) || {}).headerHash;
        const col = hash ? byHash.get(hash) : undefined;
        if (col === undefined) continue;
        out.set(fieldId, { col, entry: { ...entry, col } });
    }
    return out;
}

/** The copy is behind the file: say so, refresh it in the background, and tell the caller to try again. */
async function conflict(ctx, sentence = null) {
    await flagBehind(ctx, 'conflict');
    return new SpreadsheetSourceError(409, 'spreadsheet_conflict',
        sentence || `The file changed in ${providerName(ctx.table.source.provider)} since this table was last refreshed — it is being refreshed now; try again in a moment.`,
        { ref: refOf(ctx.table.source) });
}

async function flagBehind(ctx, reason) {
    try {
        await datatableStore.markSourceStale(ctx.table.id, reason);
        const fresh = await datatableStore.getDatatable(ctx.table.id, ctx.scope);
        if (fresh) syncModule().kickStale(fresh, { reason, delayMs: 0 });
    } catch (_) { /* best effort: the next tick or pulse re-checks anyway */ }
}

/**
 * Steps 2 and 3's first half: probe, compare the marker with the recorded
 * one (unless this is the retry after a 412, where it has moved by
 * definition and the row verification is what decides), read the sheet.
 */
async function openFile(api, ctx, fresh, { checkMarker }) {
    const source = ctx.table.source;
    const probe = await api.probe(refOf(source));
    if (!probe.format) {
        throw new SpreadsheetSourceError(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: refOf(source) });
    }
    const recorded = fresh && fresh.syncState && fresh.syncState.marker;
    if (checkMarker && recorded && !api.markerEquals(probe.marker, recorded)) throw await conflict(ctx);
    const mode = source.write.mode;
    const viaCells = probe.format === 'gsheet' || (!!api.cells && mode === 'graph_workbook');
    if (CELLS_MODES.has(mode) && !api.cells) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `${providerName(source.provider)} offers no cell API for this file from here.`, { ref: refOf(source) });
    }
    const rowCap = Math.min(ENGINE_READ_CAP, Number(source.rowCap) || DEFAULT_ROW_CAP);
    const headerRow = Number(source.headerRow) || 1;
    const sheetName = (source.sheet && source.sheet.name) || null;
    const read = await reading.readSheetOf(api, probe, { sheet: sheetName, headerRow, rowCap, viaCells });
    const cols = currentColumns(read, source);
    const ident = identity.identityOf(source);
    const keyEntry = ident.mode === 'key' ? cols.get(ident.keyFieldId) : null;
    // The key column not in the header any more: the pass identifies rows
    // by number until the owner picks another, and so does a write.
    const effective = keyEntry ? 'key' : 'row';
    const keyCol = keyEntry ? keyEntry.col : null;
    const keyType = keyEntry ? (keyEntry.entry.type || 'text') : 'text';
    const ids = identity.assignRowIds(read.rows, read.rowNumbers, { mode: effective, keyCol, keyType });
    const index = new Map();
    ids.ids.forEach((id, i) => { if (id !== null && !index.has(id)) index.set(id, i); });
    // The column map with every col as it is NOW, for reading rows back.
    const columnMap = {};
    for (const [fieldId, entry] of Object.entries(source.columnMap || {})) {
        if (!entry) continue;
        if (entry.derived) { columnMap[fieldId] = entry; continue; }
        const cur = cols.get(fieldId);
        if (cur) columnMap[fieldId] = cur.entry;
    }
    return { probe, read, cols, columnMap, mode, viaCells, rowCap, headerRow, sheetName, effective, keyCol, index };
}

// ─── Locating and verifying rows ────────────────────────────────────────

function rowMissing(rowId) {
    return new SpreadsheetSourceError(404, ROW_MISSING, `Row ${rowId} is no longer in the sheet.`, { errorClass: 'datatable_not_found' });
}

/** The copy's row at owner grade — what the sheet row must still agree with. */
async function copyRow(ctx, rowId) {
    const q = queryCompiler.compileGetById(ctx.tableMeta, rowId, ownerFilter(ctx.tableMeta, 'read'), PG);
    const found = await datatableDbStore.query(ctx.scopeKey, ctx.scopeKey, q.sql, q.params);
    return (found.rows || [])[0] || null;
}

function dateKeys(v) {
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return [];
        const pad = (n) => String(n).padStart(2, '0');
        // A pg DATE arrives as a Date at midnight of the driver's own zone;
        // both readings of it name the same day as the codec's 'YYYY-MM-DD'.
        return [v.toISOString().slice(0, 10), `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`];
    }
    return [String(v).trim().slice(0, 10)];
}

function boolOf(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === 't' || s === '1' || s === 'yes';
}

/** Does the copy's value (as Postgres hands it back) say the same as the sheet's (through the read codec)? */
function sameValue(local, fromSheet, type) {
    const a = isBlank(local);
    const b = isBlank(fromSheet);
    if (a || b) return a && b;
    switch (type) {
        case 'number': return Number(local) === Number(fromSheet);
        case 'bool': return boolOf(local) === boolOf(fromSheet);
        case 'date': {
            const l = dateKeys(local);
            const s = dateKeys(fromSheet);
            return l.some(x => s.includes(x));
        }
        case 'datetime': {
            const tl = local instanceof Date ? local.getTime() : Date.parse(String(local));
            const ts = Date.parse(String(fromSheet));
            return Number.isFinite(tl) && Number.isFinite(ts) ? tl === ts : String(local) === String(fromSheet);
        }
        default: return String(local) === String(fromSheet);
    }
}

/** Row mode: the sheet row at `r<n>` must still be the row the copy holds. */
async function verifyRow(ctx, open, rowId, index) {
    const copy = await copyRow(ctx, rowId);
    if (!copy) return;
    const cells = open.read.rows[index] || [];
    const fieldsById = fieldsByIdOf(ctx.tableMeta);
    for (const [fieldId, { col, entry }] of open.cols) {
        const field = fieldsById.get(fieldId);
        if (!field || !(field.key in copy)) continue;
        const type = entry.type || field.type;
        if (!sameValue(copy[field.key], readCell(cells[col], { ...entry, type }), type)) {
            throw await conflict(ctx, `Row ${open.read.rowNumbers[index]} of the sheet no longer holds what this table shows for ${rowId} — the table is being refreshed; try again in a moment.`);
        }
    }
}

/**
 * Intents → concrete ops on the sheet as it is now. Every row is located
 * (and, in row mode, verified) BEFORE anything is written, so a batch that
 * cannot be applied whole is not applied at all.
 * @param {Array<{ kind:'update'|'append'|'delete', rowId?, wire?, tolerateMissing? }>} intents
 * @returns {Promise<{ ops:Array, missing:Set<number> }>}  ops carry `intent` (its index)
 */
async function plan(ctx, open, intents) {
    const ops = [];
    const missing = new Set();
    const newKeys = new Map();       // id → intent index, keys this batch introduces
    const cellsOf = async (wire) => {
        const out = {};
        for (const [fieldId, value] of wire.cells) {
            const cur = open.cols.get(fieldId);
            if (!cur) throw await conflict(ctx, 'A column of this table is no longer in the sheet — the table is being refreshed; try again in a moment.');
            out[cur.col] = value;
        }
        return out;
    };
    const claimKey = (id, i) => {
        if (open.index.has(id) || newKeys.has(id)) {
            throw new SpreadsheetSourceError(409, 'key_duplicate', `A row with key "${id}" is already in the sheet.`, { detail: id });
        }
        newKeys.set(id, i);
    };
    for (let i = 0; i < intents.length; i += 1) {
        const it = intents[i];
        if (it.kind === 'append') {
            if (open.effective === 'key' && !it.wire.key) {
                const keyEntry = open.columnMap[identity.identityOf(ctx.table.source).keyFieldId] || {};
                throw new SpreadsheetSourceError(422, 'key_missing', `"${keyEntry.header || 'the key column'}" is the key column and every new row needs a value in it.`);
            }
            if (open.effective === 'key') claimKey(it.wire.key.id, i);
            ops.push({ op: 'append', intent: i, cells: await cellsOf(it.wire) });
            continue;
        }
        const index = open.index.get(it.rowId);
        if (index === undefined) {
            if (it.tolerateMissing) { missing.add(i); continue; }
            throw rowMissing(it.rowId);
        }
        const rowNumber = open.read.rowNumbers[index];
        if (open.effective === 'row') await verifyRow(ctx, open, it.rowId, index);
        if (it.kind === 'delete') {
            ops.push({ op: 'delete', intent: i, index, row: rowNumber });
            continue;
        }
        if (open.effective === 'key' && it.wire.key && it.wire.key.id !== it.rowId) claimKey(it.wire.key.id, i);
        ops.push({ op: 'update', intent: i, index, row: rowNumber, cells: await cellsOf(it.wire) });
    }
    return { ops, missing };
}

// ─── Writing, per mode ──────────────────────────────────────────────────

/** A write-codec value as the cell APIs want it: dates as serial numbers. */
function cellsValue(value) {
    if (value instanceof Date) return isoToSerial(value);
    return value;
}

function cellListOf(open, cellsByCol) {
    const typeOfCol = new Map([...open.cols.values()].map(({ col, entry }) => [col, entry.type || 'text']));
    return Object.entries(cellsByCol).map(([col, value]) => ({ col: Number(col), value: cellsValue(value), type: typeOfCol.get(Number(col)) || 'text' }));
}

/**
 * The sheet after the ops, computed in memory from the read: what a cells
 * write leaves behind (a re-read would cost the same API calls again).
 * `touched` lists the post-write row numbers of the rows written (updates
 * and appends) — the ones a cell API may have recalculated.
 */
function applyInMemory(open, ops, appended) {
    const rows = open.read.rows.map(r => [...r]);
    const rowNumbers = [...open.read.rowNumbers];
    const span = open.read.header.length;
    const written = new Set();
    for (const op of ops.filter(o => o.op === 'update')) {
        for (const [col, value] of Object.entries(op.cells)) rows[op.index][Number(col)] = cellsValue(value);
        written.add(rows[op.index]);
    }
    const deletes = ops.filter(o => o.op === 'delete').sort((a, b) => b.index - a.index);
    for (const op of deletes) {
        rows.splice(op.index, 1);
        rowNumbers.splice(op.index, 1);
        for (let i = op.index; i < rowNumbers.length; i += 1) rowNumbers[i] -= 1;
    }
    ops.filter(o => o.op === 'append').forEach((op, i) => {
        const cells = new Array(span).fill(null);
        for (const [col, value] of Object.entries(op.cells)) cells[Number(col)] = cellsValue(value);
        rows.push(cells);
        rowNumbers.push(appended[i]);
        written.add(cells);
    });
    const touched = [];
    rows.forEach((r, i) => { if (written.has(r)) touched.push(rowNumbers[i]); });
    return { header: open.read.header, rows, rowNumbers, touched };
}

/**
 * The rows a cell API just recalculated, read back into the post state:
 * the formula cells of a written row hold new results the in-memory copy
 * cannot know. Returns false for a cell API without readRow (the caller
 * flags the copy behind instead).
 */
async function readBackRecalculated(api, file, sheet, post) {
    if (!api.cells || typeof api.cells.readRow !== 'function') return false;
    const span = post.header.length;
    const at = new Map();
    post.rowNumbers.forEach((n, i) => at.set(n, i));
    for (const n of post.touched || []) {
        const i = at.get(n);
        if (i === undefined) continue;
        const fresh = await api.cells.readRow(file, sheet, n);
        const cells = new Array(span).fill(null);
        for (let c = 0; c < span && c < (fresh || []).length; c += 1) cells[c] = isBlank(fresh[c]) ? null : fresh[c];
        post.rows[i] = cells;
    }
    return true;
}

/** Step 4 for the cell APIs: updates, then deletes bottom-up (row numbers stay true), then appends — the marker chained. */
async function writeCells(api, ctx, open, ops) {
    const source = ctx.table.source;
    const file = open.probe.file;
    // The sheet as the cell APIs address it: `{ id, name }` (Sheets by gid,
    // Graph by worksheet id, either by name when the id is unknown).
    const sheet = source.sheet && (source.sheet.id != null || source.sheet.name) ? source.sheet : (open.sheetName || 0);
    let marker = open.probe.marker;
    const appended = [];
    let applied = 0;
    let shifted = false;
    try {
        for (const op of ops.filter(o => o.op === 'update')) {
            marker = (await api.cells.updateCells(file, sheet, op.row, cellListOf(open, op.cells), { ifMatch: marker })).marker;
            applied += 1;
        }
        for (const op of ops.filter(o => o.op === 'delete').sort((a, b) => b.row - a.row)) {
            marker = (await api.cells.deleteRow(file, sheet, op.row, { ifMatch: marker })).marker;
            applied += 1;
        }
        let afterRow = open.read.truncated ? null : open.read.lastDataRow;
        for (const op of ops.filter(o => o.op === 'append')) {
            const r = await api.cells.appendRow(file, sheet, cellListOf(open, op.cells), { ifMatch: marker, afterRow });
            marker = r.marker;
            appended.push(r.rowNumber);
            // Landed inside the block we read: the rows under it shifted
            // down, and the in-memory post state does not model that.
            if (afterRow !== null && r.rowNumber <= afterRow) shifted = true;
            afterRow = afterRow === null ? null : Math.max(afterRow, r.rowNumber);
            applied += 1;
        }
    } catch (e) {
        // Rows already written at the storage are ahead of the copy.
        if (applied > 0 && e && typeof e === 'object') {
            await flagBehind(ctx, 'write');
            e.copyFlagged = true;
        }
        throw e;
    }
    const post = applyInMemory(open, ops, appended);
    // Formula columns: the cell API recalculated them as it wrote. The rows
    // written are read back; without readRow the copy is flagged instead.
    let behind = shifted;
    const formulas = open.read.formulaCols && open.read.formulaCols.size > 0;
    if (formulas && post.touched.length && !(await readBackRecalculated(api, file, sheet, post))) behind = true;
    return { marker, appended, post, retried: false, behind };
}

/** Step 4 for the byte formats: one download (cached), the edit in place, one guarded upload. */
async function writeBytes(api, ctx, open, ops) {
    const source = ctx.table.source;
    const probe = open.probe;
    const buffer = await reading.bytesOf(api, probe);
    const colEntries = {};
    for (const { col, entry } of open.cols.values()) colEntries[col] = entry;
    const fileOps = ops.map((op) => (op.op === 'append' ? { op: 'append', cells: op.cells } : op.op === 'delete' ? { op: 'delete', row: op.row } : { op: 'update', row: op.row, cells: op.cells }));
    const edited = await formats.editInPlace(buffer, {
        format: probe.format, sheet: open.sheetName, headerRow: open.headerRow, ops: fileOps,
        columns: colEntries,
        // The dialect of the very bytes being edited (the read that located
        // the rows sniffed them); the stored one only as a fallback.
        csv: open.read.csv || source.csv || (ctx.table.syncState && ctx.table.syncState.csv) || null,
        expectSpan: open.read.header.length,
    });
    // A cell the editor could not take (a formula the column map did not
    // know about): refuse the whole write BEFORE the upload, naming the
    // column — a 200 with the value silently dropped is the worse answer.
    if (Array.isArray(edited.skipped) && edited.skipped.length) {
        const byCol = new Map([...open.cols.values()].map(({ col, entry }) => [col, entry]));
        const names = [...new Set(edited.skipped.map(x => Number(x.col)))]
            .map(c => (byCol.get(c) && byCol.get(c).header) || `column ${c + 1}`);
        throw new SpreadsheetSourceError(400, 'derived_column',
            `${names.map(n => `"${n}"`).join(', ')} holds a formula in the file and is read-only here — change the cells it is computed from.`,
            { detail: names });
    }
    const up = await api.upload(probe.file, edited.buffer, { ifMatch: probe.marker, contentType: null });
    const marker = up && up.marker ? up.marker : (await api.probe(refOf(source))).marker;
    // The bytes we just put there ARE the file at its new marker: the next
    // fetch (a forced pass after a row-mode delete, a stale mark) needs no
    // download, and the parse below is the one that pass would do.
    const key = cache.keyOf(probe.file.provider, reading.fileIdOf(probe.file), marker);
    await cache.bytes(key, async () => edited.buffer);
    const post = await reading.readSheetOf(api, { ...probe, marker, size: edited.buffer.length }, {
        sheet: open.sheetName, headerRow: open.headerRow, rowCap: open.rowCap, viaCells: false,
    });
    return { marker, appended: edited.appended || [], post, retried: false };
}

/**
 * Steps 1–5 for one list of intents. Returns what the storage now holds
 * for each intent: `raws[i]` = `{ id, rowNumber, cells, columnMap }` or
 * null for a row that was not in the sheet (tolerated).
 */
async function writeFile(api, ctx, intents) {
    const source = ctx.table.source;
    return cache.withLock(lockKeyOf(source), async () => {
        const fresh = (await datatableStore.getDatatable(ctx.table.id, ctx.scope)) || ctx.table;
        let open = await openFile(api, ctx, fresh, { checkMarker: true });
        scratchOf(ctx).mode = open.effective;
        let planned = await plan(ctx, open, intents);
        if (!planned.ops.length) return intents.map(() => null);
        const write = BYTE_MODES.has(open.mode) ? writeBytes : writeCells;
        let result;
        try {
            result = await write(api, ctx, open, planned.ops);
        } catch (e) {
            const raced = e && e.code === 'spreadsheet_conflict' && BYTE_MODES.has(open.mode);
            if (!raced) {
                // A cell API's own guard said the file moved: the copy is behind.
                if (e && e.code === 'spreadsheet_conflict' && !e.copyFlagged) await flagBehind(ctx, 'conflict');
                throw e;
            }
            // A second writer beat us to the PUT: the file is not what we
            // read. Once more from the top on the fresh bytes — the marker
            // has moved by definition, the rows are verified again — and
            // then it is a conflict.
            open = await openFile(api, ctx, fresh, { checkMarker: false });
            planned = await plan(ctx, open, intents);
            if (!planned.ops.length) return intents.map(() => null);
            try {
                result = await write(api, ctx, open, planned.ops);
            } catch (e2) {
                if (e2 && e2.code === 'spreadsheet_conflict') throw await conflict(ctx);
                throw e2;
            }
            result.retried = true;
        }
        await record(api, ctx, open, result);
        return rawsOf(open, planned, result, intents);
    });
}

/** Step 5. */
async function record(api, ctx, open, result) {
    const source = ctx.table.source;
    const now = new Date().toISOString();
    // The pass's own hash: in row mode the row numbers are part of it
    // (reading.contentHashOf), and `post` carries them on both roads.
    const contentHash = reading.contentHashOf(result.post.header, result.post.rows, open.effective === 'row' ? result.post.rowNumbers : null);
    const after = await datatableStore.patchSyncState(ctx.table.id, { marker: result.marker, contentHash, lastWriteAt: now });
    const running = !!(after && after.syncState && after.syncState.status === 'running');
    if (running) await datatableStore.markSourceStale(ctx.table.id, 'write');
    else if (result.retried || result.behind) await flagBehind(ctx, 'write');
    // Other tabs of the same file: our write moved their marker without
    // touching their rows. Only a sibling that was at the marker we
    // verified may follow it — one that was already behind stays behind.
    const orgId = ctx.table.organizationId || null;
    const fileId = source.file && source.file.id;
    if (!orgId || !fileId || typeof datatableStore.listSourceMirrorsByRef !== 'function') return;
    let siblings = [];
    try { siblings = await datatableStore.listSourceMirrorsByRef(orgId, { kind: KIND, provider: source.provider, fileId }); } catch (_) { siblings = []; }
    for (const m of siblings) {
        if (!m || m.id === ctx.table.id) continue;
        const theirs = m.syncState && m.syncState.marker;
        if (theirs && api.markerEquals(theirs, open.probe.marker)) {
            await datatableStore.patchSyncState(m.id, { marker: result.marker }).catch(() => null);
        }
    }
}

/** What each intent's row looks like now, from the post-write sheet. */
function rawsOf(open, planned, result, intents) {
    const post = result.post;
    const at = new Map();
    post.rowNumbers.forEach((n, i) => at.set(n, i));
    const span = post.header.length;
    // A row the capped read does not reach (an append past 10 000 rows) is
    // what we wrote, nothing else.
    const cellsAt = (rowNumber, written = null) => {
        const i = at.get(rowNumber);
        if (i !== undefined) return post.rows[i];
        const cells = new Array(span).fill(null);
        for (const [col, value] of Object.entries(written || {})) cells[Number(col)] = cellsValue(value);
        return cells;
    };
    const raws = intents.map(() => null);
    let appendedAt = 0;
    for (const op of planned.ops) {
        const it = intents[op.intent];
        if (op.op === 'delete') { raws[op.intent] = { id: it.rowId, rowNumber: op.row, cells: [], columnMap: open.columnMap }; continue; }
        if (op.op === 'append') {
            const rowNumber = result.appended[appendedAt];
            appendedAt += 1;
            const id = open.effective === 'key' ? it.wire.key.id : identity.rowIdFromNumber(rowNumber);
            raws[op.intent] = { id, rowNumber, cells: cellsAt(rowNumber, op.cells), columnMap: open.columnMap };
            continue;
        }
        const id = open.effective === 'key' && it.wire.key ? it.wire.key.id : it.rowId;
        raws[op.intent] = { id, rowNumber: op.row, cells: cellsAt(op.row, op.cells), columnMap: open.columnMap };
    }
    return raws;
}

// ─── The adapter the shared half drives ─────────────────────────────────

function scratchOf(ctx) {
    if (!ctx[SCRATCH]) ctx[SCRATCH] = { raws: new Map(), mode: null };
    return ctx[SCRATCH];
}

const indexMemo = new WeakMap();
/** The relation indexes, once per write call (the shared half asks per row). */
function indexesFor(ctx) {
    if (!indexMemo.has(ctx)) indexMemo.set(ctx, buildRelationIndexes(ctx.scope, ctx.table.source));
    return indexMemo.get(ctx);
}

async function linkerApi(ctx) {
    const linker = await linkerAuth().resolveLinker(ctx.table.source, { orgId: ctx.table.organizationId || null, write: true });
    return linker.api;
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
            } catch (_) { /* the shared half reports (or collects) the refusal itself */ }
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
