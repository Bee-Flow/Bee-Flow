// @typecheck
/**
 * The cells of a SPREADSHEET document, kept in a datatable.
 *
 * A spreadsheet is a document of type 'spreadsheet' (stores/documentStore.js)
 * whose `settings.sheet.datatableId` names a personal datatable of the
 * managed kind `document_sheet` (dataModel/managedTables.js): one row per
 * sheet row, `row_no` its number, `a` … `z` what was typed in each column.
 * Keeping the cells there, rather than in the document row, makes a sheet's
 * data what every other datatable is: readable by automations and apps, sortable,
 * exportable, counted in the same quota, erased with the same person.
 *
 * What is stored is what was TYPED: a value, or a formula as text
 * (`=SUM(A1:A3)`). Formulas are evaluated by the shared sheet engine
 * (shared/expr/sheet.mjs), in the browser while editing and here for an
 * export, never stored evaluated, so a value can never go stale against the
 * formula that made it.
 *
 * Every read and write goes through core/dataEngine/datatableRuntime as the
 * DOCUMENT OWNER — the table is theirs. Who may read or edit the sheet is the
 * document's question (owner, or a project member with the right role),
 * decided by the route before it calls in here.
 *
 * Writes are per cell: a batch is grouped by row, and each row is read fresh
 * and updated with only the columns that changed, under the row's optimistic
 * lock. A colleague who changed another cell of the same row in between is
 * not overwritten — the write is retried on the fresh row. A row that does
 * not exist yet is inserted; `row_no` is unique, so two writers creating the
 * same row cannot both succeed, and the loser updates the winner's row.
 *
 * A FACTORY (`makeSheetCells(deps)`) so the tests run it on fakes; the
 * default export is over the real modules.
 */

'use strict';

const crypto = require('crypto');

/** Columns A–Z: the managed kind's own column keys. */
const COLUMN_KEYS = Object.freeze('abcdefghijklmnopqrstuvwxyz'.split(''));
const ALLOW_COLUMNS = Object.freeze(['row_no', ...COLUMN_KEYS]);
/** The most rows a sheet holds, and so the most it reads back in one go. */
const MAX_SHEET_ROWS = 2000;
/** What one cell may hold. */
const MAX_CELL_CHARS = 10_000;
/** Cells per write request: a paste of a few hundred cells, not a whole file. */
const MAX_CELLS_PER_WRITE = 500;
/** Attempts per row when somebody else wrote the same row in between. */
const ROW_RETRIES = 3;
/** The compiler's own cap on an `in` list (queryCompiler MAX_IN_VALUES). */
const IN_CHUNK = 200;
const PAGE = 500;

const CELL_RE = /^([A-Z])([1-9][0-9]{0,4})$/;

const { HttpError } = require('../http/errors');

/** A refusal the route passes through as-is (status, code, message). */
function sheetError(status, code, message) {
    return new HttpError(status, code, message);
}

/**
 * 'B12' → { key: 'b', row: 12 }, or null for anything outside A1:Z{MAX}.
 * @param {string} name
 */
function parseCellName(name) {
    const m = CELL_RE.exec(String(name || '').trim().toUpperCase());
    if (!m) return null;
    const row = Number(m[2]);
    if (row < 1 || row > MAX_SHEET_ROWS) return null;
    return { key: m[1].toLowerCase(), row };
}

/**
 * Check and group a write: `{ B3: '12', C3: '' }` → Map(3 → { b: '12', c: null }).
 * An empty string clears the cell (stored as NULL).
 *
 * @param {Record<string, unknown>} cells
 * @returns {Map<number, Record<string, string|null>>}
 */
function groupWrite(cells) {
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
        throw sheetError(400, 'sheet_cells_required', 'Send the cells to change as { cells: { "A1": "…" } }.');
    }
    const entries = Object.entries(cells);
    if (!entries.length) throw sheetError(400, 'sheet_cells_required', 'Send at least one cell to change.');
    if (entries.length > MAX_CELLS_PER_WRITE) {
        throw sheetError(413, 'sheet_write_too_large', `Change at most ${MAX_CELLS_PER_WRITE} cells at a time.`);
    }
    /** @type {Map<number, Record<string, string|null>>} */
    const byRow = new Map();
    for (const [name, raw] of entries) {
        const at = parseCellName(name);
        if (!at) throw sheetError(400, 'sheet_cell_out_of_range', `"${name}" is not a cell of this sheet: columns A to Z, rows 1 to ${MAX_SHEET_ROWS}.`);
        if (raw !== null && typeof raw !== 'string') throw sheetError(400, 'sheet_cell_not_text', `What goes in ${name} is text.`);
        // Narrowed by the check above: null or a string.
        const text = raw === null ? '' : /** @type {string} */ (raw);
        if (text.length > MAX_CELL_CHARS) throw sheetError(413, 'sheet_cell_too_long', `${name} holds at most ${MAX_CELL_CHARS.toLocaleString('en-US')} characters.`);
        const values = byRow.get(at.row) || {};
        values[at.key] = text === '' ? null : text;
        byRow.set(at.row, values);
    }
    return byRow;
}

/** Datatable rows → `{ cells: { A1: … }, rows }` (rows = the last row with anything in it). */
function cellsOfRows(rows) {
    /** @type {Record<string, string>} */
    const cells = {};
    let used = 0;
    for (const r of rows) {
        const n = Number(r.row_no);
        if (!Number.isInteger(n) || n < 1 || n > MAX_SHEET_ROWS) continue;
        for (const k of COLUMN_KEYS) {
            const v = r[k];
            if (v === null || v === undefined || v === '') continue;
            cells[`${k.toUpperCase()}${n}`] = String(v);
            if (n > used) used = n;
        }
    }
    return { cells, rows: used };
}

/** The optimistic-lock token as the compiler compares it: an ISO string. */
const stamp = (/** @type {unknown} */ v) => (v instanceof Date ? v.toISOString() : String(v));
const isUniqueViolation = (/** @type {any} */ e) => e && (e.code === '23505' || /unique|duplicate key/i.test(String(e.message || '')));
const isRowConflict = (/** @type {any} */ e) => e && e.status === 409 && e.code === 'row_conflict';

/**
 * @param {object} [deps]
 * @param {any} [deps.runtime]        core/dataEngine/datatableRuntime
 * @param {(userId: string) => Promise<any>} [deps.principalFor]
 * @param {(o: any) => Promise<any>} [deps.provision]   core/dataEngine/provisionManagedTable
 * @param {(userId: string) => any} [deps.userScope]
 * @param {(kind: string) => any} [deps.spec]
 * @param {(id: string, scope: any) => Promise<boolean>} [deps.drop]   datatableDbStore.dropDatatable
 */
function makeSheetCells(deps = {}) {
    const runtime = () => deps.runtime || require('../dataEngine/datatableRuntime');
    const principalFor = (/** @type {string} */ userId) => (deps.principalFor
        || require('../../auth/datatableAccess').resolveDatatablePrincipalForUser)(userId);
    const provision = (/** @type {any} */ o) => (deps.provision || require('../dataEngine/provisionManagedTable').provisionManagedTable)(o);
    const userScope = (/** @type {string} */ userId) => (deps.userScope || require('../../stores/datatableStore').userScope)(userId);
    const spec = () => (deps.spec || require('../dataEngine/dataModel/managedTables').managedKindSpec)('document_sheet');
    const drop = (/** @type {string} */ id, /** @type {any} */ scope) => (deps.drop || require('../../stores/datatableDbStore').dropDatatable)(id, scope);

    /** The owner's table, resolved as the owner. A missing one is the sheet's own 410. */
    async function open(ownerUserId, datatableId, needed = 'viewer') {
        try {
            return await runtime().resolveForPrincipal(datatableId, await principalFor(ownerUserId), { needed });
        } catch (e) {
            if (e && e.status === 404) {
                throw sheetError(410, 'sheet_table_missing', 'The table that holds this spreadsheet\'s cells is gone (deleted under Studio → Datatables). The cells cannot be shown.');
            }
            throw e;
        }
    }

    /**
     * Make the table a new spreadsheet keeps its cells in: personal, owned by
     * whoever creates the document, named after it.
     *
     * @param {{ ownerUserId: string, name: string, projectId?: string|null }} o
     * @returns {Promise<{ id: string }>}
     */
    async function createSheetTable({ ownerUserId, name, projectId = null }) {
        const kind = spec();
        const label = `Spreadsheet: ${String(name || 'Untitled').trim() || 'Untitled'}`.slice(0, 120);
        return provision({
            scope: userScope(ownerUserId), ownerUserId, spec: kind,
            key: `sheet_${crypto.randomBytes(6).toString('hex')}`,
            name: label, description: kind.defaultDescription, projectId,
        });
    }

    /** Every row of the sheet, in row order, up to MAX_SHEET_ROWS. */
    async function readAllRows(resolved) {
        const out = [];
        let cursor = null;
        for (;;) {
            const page = await runtime().readRows(resolved, {
                allowColumns: ALLOW_COLUMNS, sort: { field: 'row_no', dir: 'asc' }, limit: PAGE, cursor,
            });
            out.push(...page.rows);
            if (!page.hasMore || !page.nextCursor || out.length >= MAX_SHEET_ROWS) break;
            cursor = page.nextCursor;
        }
        return out;
    }

    /**
     * @param {string} ownerUserId
     * @param {string} datatableId
     * @returns {Promise<{ cells: Record<string, string>, rows: number, columns: number }>}
     */
    async function readSheet(ownerUserId, datatableId) {
        const resolved = await open(ownerUserId, datatableId, 'viewer');
        return { ...cellsOfRows(await readAllRows(resolved)), columns: COLUMN_KEYS.length };
    }

    /** The current rows with these numbers, by number. */
    async function rowsByNumber(resolved, numbers) {
        /** @type {Map<number, any>} */
        const found = new Map();
        for (let i = 0; i < numbers.length; i += IN_CHUNK) {
            const chunk = numbers.slice(i, i + IN_CHUNK);
            const page = await runtime().readRows(resolved, {
                allowColumns: ALLOW_COLUMNS, filters: [{ field: 'row_no', op: 'in', value: chunk }], limit: IN_CHUNK,
            });
            for (const r of page.rows) found.set(Number(r.row_no), r);
        }
        return found;
    }

    /** Write one row's changed columns, retrying on a colleague's write to the same row. */
    async function writeRow(resolved, rowNo, values, current) {
        let row = current;
        for (let attempt = 0; attempt < ROW_RETRIES; attempt++) {
            try {
                if (row) {
                    await runtime().updateRow(resolved, {
                        allowColumns: ALLOW_COLUMNS, rowId: row.id, values, expectedUpdatedAt: stamp(row.updated_at),
                    });
                } else {
                    await runtime().insertRow(resolved, { allowColumns: ALLOW_COLUMNS, values: { row_no: rowNo, ...values } });
                }
                return;
            } catch (e) {
                // Somebody wrote this row in between (an edit, or created it
                // first): read it again and put only our columns on top.
                if (!isRowConflict(e) && !isUniqueViolation(e)) throw e;
                row = (await rowsByNumber(resolved, [rowNo])).get(rowNo) || null;
            }
        }
        throw sheetError(409, 'sheet_busy', 'Somebody else is changing the same row right now. Try again in a moment.');
    }

    /**
     * Change cells. `cells` maps a cell name to what was typed ('' clears it).
     *
     * @param {string} ownerUserId
     * @param {string} datatableId
     * @param {Record<string, unknown>} cells
     * @returns {Promise<{ cells: Record<string, string> }>} what was saved, '' for a cleared cell
     */
    async function writeCells(ownerUserId, datatableId, cells) {
        const byRow = groupWrite(cells);
        const resolved = await open(ownerUserId, datatableId, 'editor');
        const numbers = [...byRow.keys()].sort((a, b) => a - b);
        const existing = await rowsByNumber(resolved, numbers);
        for (const n of numbers) {
            const values = /** @type {Record<string, string|null>} */ (byRow.get(n));
            const current = existing.get(n) || null;
            // Clearing cells of a row that does not exist is nothing to do.
            if (!current && Object.values(values).every((v) => v === null)) continue;
            await writeRow(resolved, n, values, current);
        }
        /** @type {Record<string, string>} */
        const saved = {};
        for (const [n, values] of byRow) {
            for (const [k, v] of Object.entries(values)) saved[`${k.toUpperCase()}${n}`] = v ?? '';
        }
        return { cells: saved };
    }

    /**
     * Copy every cell of one sheet into another (duplicating a spreadsheet):
     * read as the source document's owner, written as the copy's.
     *
     * @param {string} fromOwnerUserId
     * @param {string} fromTableId
     * @param {string} toTableId
     * @param {string} toOwnerUserId
     */
    async function copyCells(fromOwnerUserId, fromTableId, toTableId, toOwnerUserId) {
        const { cells } = await readSheet(fromOwnerUserId, fromTableId);
        const names = Object.keys(cells);
        for (let i = 0; i < names.length; i += MAX_CELLS_PER_WRITE) {
            const part = Object.fromEntries(names.slice(i, i + MAX_CELLS_PER_WRITE).map((k) => [k, cells[k]]));
            await writeCells(toOwnerUserId, toTableId, part);
        }
    }

    /**
     * Remove a sheet's table (a spreadsheet whose document could not be made).
     * @param {string} ownerUserId
     * @param {string} tableId
     */
    async function dropSheetTable(ownerUserId, tableId) {
        return drop(tableId, userScope(ownerUserId));
    }

    return { createSheetTable, readSheet, writeCells, copyCells, dropSheetTable };
}

module.exports = makeSheetCells();
module.exports.makeSheetCells = makeSheetCells;
module.exports.parseCellName = parseCellName;
module.exports.groupWrite = groupWrite;
module.exports.cellsOfRows = cellsOfRows;
module.exports.LIMITS = Object.freeze({ MAX_SHEET_ROWS, MAX_CELL_CHARS, MAX_CELLS_PER_WRITE, COLUMNS: COLUMN_KEYS.length });
