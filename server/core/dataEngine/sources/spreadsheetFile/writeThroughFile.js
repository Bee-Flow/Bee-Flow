const datatableStore = require('../../../../stores/datatableStore');
const { ENGINE_READ_CAP, DEFAULT_ROW_CAP } = require('../mirror/constants');
const { KIND } = require('./index');
const { SpreadsheetSourceError, providerName } = require('./errors');
const { isoToSerial, isBlank } = require('./cells');
const columns = require('./columns');
const identity = require('./identity');
const reading = require('./reading');
const cache = require('./cache');
const formats = require('./formats');
const { ROW_MISSING, syncModule, refOf, conflict, flagBehind, sameValue, plan } = require('./writeThroughPlan');

const CELLS_MODES = new Set(['sheets_api', 'graph_workbook']);

const BYTE_MODES = new Set(['exceljs_put', 'csv_put']);

/** Per-call scratch the storage half leaves for the wrapper (post-write rows, the effective identity mode). */
const SCRATCH = Symbol('spreadsheetWrite');

function lockKeyOf(source) {
    return cache.lockKeyOf(source.provider, reading.fileIdOf({ provider: source.provider, ...(source.file || {}), fileId: (source.file || {}).id }));
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

function scratchOf(ctx) {
    if (!ctx[SCRATCH]) ctx[SCRATCH] = { raws: new Map(), mode: null };
    return ctx[SCRATCH];
}

module.exports = { ROW_MISSING, syncModule, currentColumns, flagBehind, sameValue, writeFile, scratchOf };
