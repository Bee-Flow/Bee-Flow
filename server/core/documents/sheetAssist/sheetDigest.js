// @typecheck
/**
 * What the spreadsheet assistant SEES of a sheet, in as few tokens as the job
 * allows.
 *
 * A grid as JSON (`{"A1":"Item","B1":"Qty",…}`) spends most of its tokens on
 * quotes and cell names. The digest is a table instead: a header line of
 * column letters, then one line per row, cells separated by ` | `, the row
 * number first — the way people and models read a spreadsheet. A formula
 * shows as typed, followed by `⇒` and what it computes to, so the model can
 * check its own arithmetic without a second call.
 *
 * A small sheet goes in whole. A large one goes as its first rows (where the
 * headers are), its last rows (where totals usually are), a profile per
 * column (how many values, numbers, formulas; min/max/sum) and the user's
 * selection; the assistant reads the rest with `read_range` when it needs it.
 *
 * `rowsBlock` is also what `read_range` answers with, so the two read alike.
 */

'use strict';

const { colName, cellsIn } = require('./sheetRefs');

/** Whole sheet in the digest up to this many filled cells. */
const FULL_SHEET_CELLS = 600;
const HEAD_ROWS = 15;
const TAIL_ROWS = 5;
/** Characters of one cell shown in the digest; read_range shows more. */
const DIGEST_CELL_CHARS = 60;
const RANGE_CELL_CHARS = 500;

/**
 * @typedef {Record<string, string>} Cells        raw input by A1 name
 * @typedef {Record<string, { value: any, error: string|null, display: string }>} Shown
 */

/** The used rectangle: last row and last column with anything in them (0 when empty). */
function usedExtent(/** @type {Cells} */ cells) {
    let rows = 0;
    let cols = 0;
    for (const name of Object.keys(cells)) {
        const m = /^([A-Z])(\d+)$/.exec(name);
        if (!m || cells[name] === '') continue;
        rows = Math.max(rows, Number(m[2]));
        cols = Math.max(cols, m[1].charCodeAt(0) - 64);
    }
    return { rows, cols };
}

const clip = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A cell as the model reads it: newlines and pipes escaped, formulas with their result. */
function cellText(/** @type {string} */ raw, /** @type {any} */ shown, /** @type {number} */ max) {
    if (raw === undefined || raw === '') return '';
    const flat = clip(String(raw).replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|'), max);
    if (!String(raw).startsWith('=')) return flat;
    return `${flat}⇒${clip(String(shown?.display ?? ''), 40)}`;
}

/**
 * Rows r0…r1 (1-based, inclusive) over columns 0…c1, with a header of letters.
 * @param {Cells} cells
 * @param {Shown} shown
 * @param {{ r0: number, r1: number, c0?: number, c1: number, max?: number }} o
 */
function rowsBlock(cells, shown, { r0, r1, c0 = 0, c1, max = DIGEST_CELL_CHARS }) {
    const cols = [];
    for (let c = c0; c <= c1; c++) cols.push(c);
    const lines = [`#| ${cols.map(colName).join(' | ')}`];
    for (let r = r0; r <= r1; r++) {
        const values = cols.map((c) => cellText(cells[`${colName(c)}${r}`], shown[`${colName(c)}${r}`], max));
        // A blank row is said once, not as a line of empty pipes.
        lines.push(values.some(Boolean) ? `${r}| ${values.join(' | ')}` : `${r}|`);
    }
    return lines.join('\n');
}

/** Per column: how many values, numbers and formulas, and min/max/sum of the numbers. */
function columnProfiles(/** @type {Cells} */ cells, /** @type {Shown} */ shown, /** @type {number} */ cols) {
    const out = [];
    for (let c = 0; c < cols; c++) {
        const L = colName(c);
        let filled = 0; let formulas = 0; let errors = 0;
        /** @type {number[]} */
        const nums = [];
        for (const [name, raw] of Object.entries(cells)) {
            if (!name.startsWith(L) || !/^\d+$/.test(name.slice(1)) || raw === '') continue;
            filled++;
            if (String(raw).startsWith('=')) formulas++;
            const s = shown[name];
            if (s?.error) errors++;
            else if (typeof s?.value === 'number') nums.push(s.value);
        }
        if (!filled) continue;
        const parts = [`${L}: ${filled} filled`];
        if (formulas) parts.push(`${formulas} formulas`);
        if (errors) parts.push(`${errors} errors`);
        if (nums.length) {
            const sum = nums.reduce((a, b) => a + b, 0);
            parts.push(`${nums.length} numbers, min ${+Math.min(...nums).toPrecision(12)}, max ${+Math.max(...nums).toPrecision(12)}, sum ${+sum.toPrecision(12)}`);
        }
        out.push(parts.join(', '));
    }
    return out.join('\n');
}

/** Every cell that shows an error, as `D9 #DIV/0!`, at most `max` of them. */
function errorList(/** @type {Shown} */ shown, max = 30) {
    const errs = Object.entries(shown).filter(([, s]) => s && s.error).map(([n, s]) => `${n} ${s.error}`);
    return errs.length > max ? [...errs.slice(0, max), `… and ${errs.length - max} more`] : errs;
}

/**
 * @param {Cells} cells
 * @param {Shown} shown
 * @param {{ name: string, selection?: { c0: number, r0: number, c1: number, r1: number } | null, selectionKind?: string|null }} o
 * @returns {string}
 */
function sheetDigest(cells, shown, { name, selection = null, selectionKind = null }) {
    const { rows, cols } = usedExtent(cells);
    const filled = Object.values(cells).filter((v) => v !== '').length;
    if (!rows) return `Sheet "${name}" is empty. Columns A–Z, rows 1–2000.`;
    const used = `A1:${colName(cols - 1)}${rows}`;
    const parts = [`Sheet "${name}": used range ${used} (${rows} rows × ${cols} columns, ${filled} filled cells). Columns A–Z, rows up to 2000.`];
    if (filled <= FULL_SHEET_CELLS) {
        parts.push('All cells (formulas shown as typed, ⇒ what they compute):', rowsBlock(cells, shown, { r0: 1, r1: rows, c1: cols - 1 }));
    } else {
        const headEnd = Math.min(rows, HEAD_ROWS);
        parts.push(`First ${headEnd} rows:`, rowsBlock(cells, shown, { r0: 1, r1: headEnd, c1: cols - 1 }));
        if (rows > headEnd) {
            const tailStart = Math.max(headEnd + 1, rows - TAIL_ROWS + 1);
            parts.push(`Last rows (${tailStart}–${rows}):`, rowsBlock(cells, shown, { r0: tailStart, r1: rows, c1: cols - 1 }));
        }
        parts.push('Column profiles:', columnProfiles(cells, shown, cols));
        parts.push('The rows in between are not shown: use read_range or find to look at them.');
    }
    const errs = errorList(shown);
    if (errs.length) parts.push(`Cells showing an error: ${errs.join(', ')}`);
    if (selection) {
        const names = cellsIn(selection);
        const sel = `${names[0]}${names.length > 1 ? `:${names[names.length - 1]}` : ''}`;
        const L = (/** @type {number} */ c) => colName(c);
        const what = selectionKind === 'columns'
            ? `whole column${selection.c1 > selection.c0 ? 's' : ''} ${L(selection.c0)}${selection.c1 > selection.c0 ? `:${L(selection.c1)}` : ''} (${sel})`
            : selectionKind === 'rows'
                ? `whole row${selection.r1 > selection.r0 ? 's' : ''} ${selection.r0 + 1}${selection.r1 > selection.r0 ? `:${selection.r1 + 1}` : ''} (${sel})`
                : sel;
        parts.push(`The user has selected ${what}${names.length <= 400 ? ':' : ` (${names.length} cells; read_range it if needed).`}`);
        if (names.length <= 400) parts.push(rowsBlock(cells, shown, { r0: selection.r0 + 1, r1: selection.r1 + 1, c0: selection.c0, c1: selection.c1 }));
    }
    return parts.join('\n');
}

module.exports = { sheetDigest, rowsBlock, columnProfiles, errorList, usedExtent, RANGE_CELL_CHARS, FULL_SHEET_CELLS };
