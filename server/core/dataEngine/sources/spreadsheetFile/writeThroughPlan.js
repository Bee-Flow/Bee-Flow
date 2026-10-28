// @typecheck
const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const { ownerFilter } = require('../mirror/access');
const { PG } = require('../mirror/constants');
const { SpreadsheetSourceError, providerName } = require('./errors');
const { readCell, isBlank } = require('./cells');
const identity = require('./identity');
const { fieldsByIdOf } = require('./rows');
const { bestEffort } = require('../../../../utils/bestEffort');

/**
 * Internal: "this row is not in the sheet". The shared half turns it into
 * "drop the copy" (update) or "counts as deleted" (delete); it never reaches
 * a client. The FILE being gone is a different thing (spreadsheet_not_found
 * from the probe) and propagates as the error it is.
 */
const ROW_MISSING = 'spreadsheet_row_missing';

/** Lazily: sync.js requires the adapter, whose writeThrough getter requires this file. */
function syncModule() { return require('./sync'); }

function refOf(source) {
    const file = source.file || {};
    return { provider: source.provider, fileId: file.id || null, driveId: file.driveId || null, path: file.path || null, name: file.name || null };
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
    } catch (err) { bestEffort('core/dataEngine/sources/spreadsheetFile/writeThroughPlan:flagBehind', err); /* best effort: the next tick or pulse re-checks anyway */ }
}

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

module.exports = { ROW_MISSING, syncModule, refOf, conflict, flagBehind, sameValue, plan };
