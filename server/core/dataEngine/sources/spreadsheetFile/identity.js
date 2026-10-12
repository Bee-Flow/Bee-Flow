/**
 * Row identity for a sheet that has none.
 *
 * A Nextcloud Tables row carries its own id; a worksheet row does not. The
 * mirror's row id is therefore DERIVED, in one of two modes the linker chose
 * in the wizard (`source.identity`):
 *   { mode:'key', keyFieldId }  the value of one column, normalised — a
 *                               automation then sees `F-2026-001` as the id, a
 *                               row keeps its id when rows are sorted or
 *                               inserted above it, and an edit of the key
 *                               column MOVES the row to a new id;
 *   { mode:'row' }              the sheet row number as `r<n>` (1-based, the
 *                               number Excel shows — header at row 1 makes
 *                               the first data row `r2`). Cheap and always
 *                               available, but an insert above shifts every
 *                               id below it.
 *
 * Ids travel in URL paths, automation bindings and CSV exports, so a key is used
 * VERBATIM only when it is plain (`KEY_VERBATIM_RE`: letters, digits, `. _ : -`,
 * ≤ 60 chars, ≤ 64 per queryCompiler.assertRecordId); anything else — spaces,
 * slashes, quotes, accents — becomes `k_<sha256 hex[0:32]>`. Case-sensitive:
 * "abc" and "ABC" are two rows in the sheet and stay two here. The first
 * occurrence of a key wins; later duplicates are skipped and counted, so a
 * duplicate never overwrites a row silently. A fully blank row never mints
 * an id in either mode.
 *
 * A key is TYPED. A csv hands the reader raw text ('7,5'), the write codec
 * hands the writer a number (7.5), and the file may spell one number three
 * ways ('7,5', '7.5', '7.50'): a NUMBER key is therefore canonicalised
 * through the same parser the read codec uses before it is hashed or used
 * verbatim, so the id a write-through answers is the id the next pass
 * mints for the same row. A text key is the cell's text, as before.
 *
 * PURE: no database, no network.
 */

'use strict';

const crypto = require('crypto');
const { isBlank, isoDate, parseNumberish } = require('./cells');   // cells.js does not require identity: no cycle

const KEY_VERBATIM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
const HASH_PREFIX = 'k_';

/**
 * The canonical text of a key cell (what is hashed or used verbatim), or
 * null when blank. For a number key every spelling of one number is one
 * key ('7,5', '7.5', '7.50', 7.5 → '7.5'); a cell that is not a number in
 * a number key column counts as "key missing".
 * @param {*} cell
 * @param {'text'|'number'} [type]   the key column's declared type
 */
function normaliseKey(cell, type = 'text') {
    if (isBlank(cell)) return null;
    if (type === 'number') {
        const n = typeof cell === 'number' ? cell : parseNumberish(cell);
        return Number.isFinite(n) ? String(n) : null;
    }
    if (typeof cell === 'number') return Number.isFinite(cell) ? Number(cell).toString() : null;
    if (typeof cell === 'boolean') return cell ? 'true' : 'false';
    if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : isoDate(cell);
    const s = String(cell).trim().replace(/\s+/g, ' ');
    return s || null;
}

/** The row id for one key cell, or null when the cell is blank (the row is skipped). */
function rowIdFromKey(cell, type = 'text') {
    const norm = normaliseKey(cell, type);
    if (norm === null) return null;
    if (KEY_VERBATIM_RE.test(norm)) return norm;
    return HASH_PREFIX + crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32);
}

/** The row id for a sheet row number (1-based, as shown in the file). */
function rowIdFromNumber(n) {
    const row = Number(n);
    if (!Number.isInteger(row) || row < 1) throw new Error(`spreadsheetFile: row number ${n} is not a positive integer`);
    return `r${row}`;
}

/** `r12` → 12, else null. */
function rowNumberOf(id) {
    const m = /^r(\d{1,9})$/.exec(String(id || ''));
    return m ? Number(m[1]) : null;
}

/** Is every cell of this row blank? Such a row never gets an id. */
function isBlankRow(cells) {
    return !Array.isArray(cells) || cells.every(isBlank);
}

/** `source.identity` normalised — anything but a key column means row numbers. */
function identityOf(source) {
    const id = source && source.identity;
    if (id && id.mode === 'key' && typeof id.keyFieldId === 'string' && id.keyFieldId) {
        return { mode: 'key', keyFieldId: id.keyFieldId };
    }
    return { mode: 'row' };
}

/**
 * Ids for every row of a read, in order. A skipped row (blank, key missing,
 * duplicate key) gets null and is counted — the sync writes the counts into
 * `sync_state.identity` so the panel can say "3 rows were skipped".
 *
 * @param {Array<Array>} rows          the data rows (cells)
 * @param {number[]} rowNumbers        the 1-based sheet row of each entry of `rows`
 * @param {object} opts
 * @param {'key'|'row'} opts.mode
 * @param {number} [opts.keyCol]       0-based column of the key (mode 'key')
 * @param {'text'|'number'} [opts.keyType]   the key column's declared type (mode 'key')
 * @returns {{ ids:(string|null)[], missing:number, duplicate:number, blank:number }}
 */
function assignRowIds(rows, rowNumbers, { mode, keyCol = null, keyType = 'text' } = {}) {
    const ids = [];
    let missing = 0;
    let duplicate = 0;
    let blank = 0;
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 1) {
        const cells = rows[i];
        if (isBlankRow(cells)) { blank += 1; ids.push(null); continue; }
        if (mode === 'key') {
            const id = Number.isInteger(keyCol) && keyCol >= 0 ? rowIdFromKey(cells[keyCol], keyType) : null;
            if (id === null) { missing += 1; ids.push(null); continue; }
            if (seen.has(id)) { duplicate += 1; ids.push(null); continue; }
            seen.add(id);
            ids.push(id);
        } else {
            ids.push(rowIdFromNumber(rowNumbers[i]));
        }
    }
    return { ids, missing, duplicate, blank };
}

/**
 * Whether a column can be the key: every non-blank row has a value and no two
 * rows share one (first duplicate reported so a 422 can name it).
 */
function checkKeyColumn(rows, keyCol, keyType = 'text') {
    let missing = 0;
    let duplicate = 0;
    let firstDuplicate = null;
    const seen = new Set();
    for (const cells of rows) {
        if (isBlankRow(cells)) continue;
        const id = rowIdFromKey(cells[keyCol], keyType);
        if (id === null) { missing += 1; continue; }
        if (seen.has(id)) {
            duplicate += 1;
            if (firstDuplicate === null) firstDuplicate = normaliseKey(cells[keyCol], keyType);
            continue;
        }
        seen.add(id);
    }
    return { unique: missing === 0 && duplicate === 0, missing, duplicate, firstDuplicate };
}

module.exports = {
    KEY_VERBATIM_RE,
    HASH_PREFIX,
    normaliseKey,
    rowIdFromKey,
    rowIdFromNumber,
    rowNumberOf,
    isBlankRow,
    identityOf,
    assignRowIds,
    checkKeyColumn,
};
