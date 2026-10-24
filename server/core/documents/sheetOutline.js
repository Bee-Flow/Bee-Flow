// @typecheck
/**
 * The OUTLINE of a spreadsheet: what is in it, without the data itself.
 *
 * Building a dashboard, a pivot or a summary over a workbook does not need
 * every customer row: it needs the tabs, their columns, what kind of value
 * each column holds and how far it runs. The formulas (COUNTIFS, SUMIFS, …)
 * then do the counting inside the sheet. So document_read({ mode: "outline" })
 * answers with this instead of a few thousand cells — fewer tokens, and the
 * personal data in the rows stays out of the model.
 *
 * Per column: the header (row 1), a type (number, date, text, formula, mixed),
 * how many cells are filled, min/max for numbers and dates, and for a
 * CATEGORY column (few distinct values over many rows, such as a segment or a
 * status) those values. A column of names or e-mail addresses has many
 * distinct values and never lists them.
 */

'use strict';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A column lists its distinct values only when it has at most this many… */
const MAX_CATEGORIES = 12;
/** …over at least this many filled data rows (fewer rows say nothing about a category). */
const MIN_ROWS_FOR_CATEGORIES = 10;
const MAX_HEADER_CHARS = 60;
const MAX_CATEGORY_CHARS = 40;

/** 'B12' → { col: 'B', row: 12 }, or null for anything else. */
function splitName(name) {
    const m = /^([A-Z])(\d+)$/.exec(name);
    return m ? { col: m[1], row: Number(m[2]) } : null;
}

/** The kind of one data cell, judged on what it shows. */
function kindOf(raw, shown) {
    if (String(raw).startsWith('=')) return 'formula';
    if (typeof shown?.value === 'number') return 'number';
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ISO_DATE is anchored, fixed length: linear
    if (ISO_DATE.test(String(raw).trim())) return 'date';
    return 'text';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One tab's outline.
 * @param {string} name  the tab's name
 * @param {Record<string, string>} cells  typed cells by A1 name
 * @param {Record<string, { value: any, error: string|null, display: string }>} shown  what each cell computes to
 * @returns {{ name: string, rows: number, usedRange: string|null, columns: object[] }}
 */
function tabOutline(name, cells, shown) {
    /** @type {Map<string, { header: string, kinds: Record<string, number>, filled: number, min?: any, max?: any, values: Map<string, number> }>} */
    const cols = new Map();
    let lastRow = 0;
    let lastCol = '';
    for (const [cell, raw] of Object.entries(cells)) {
        if (raw === '' || raw === null || raw === undefined) continue;
        const at = splitName(cell);
        if (!at) continue;
        lastRow = Math.max(lastRow, at.row);
        if (at.col > lastCol) lastCol = at.col;
        if (!cols.has(at.col)) cols.set(at.col, { header: '', kinds: {}, filled: 0, values: new Map() });
        const col = cols.get(at.col);
        if (at.row === 1) { col.header = clip(String(shown[cell]?.display ?? raw), MAX_HEADER_CHARS); continue; }
        const kind = kindOf(raw, shown[cell]);
        col.kinds[kind] = (col.kinds[kind] || 0) + 1;
        col.filled++;
        const value = kind === 'number' ? shown[cell].value : kind === 'date' ? String(raw).trim() : null;
        if (value !== null) {
            if (col.min === undefined || value < col.min) col.min = value;
            if (col.max === undefined || value > col.max) col.max = value;
        }
        if (kind === 'text' && col.values.size <= MAX_CATEGORIES) {
            const v = clip(String(raw).trim(), MAX_CATEGORY_CHARS);
            col.values.set(v, (col.values.get(v) || 0) + 1);
        }
    }
    const columns = [...cols.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([letter, c]) => {
        const kinds = Object.entries(c.kinds).sort((a, b) => b[1] - a[1]);
        const type = !kinds.length ? 'empty' : kinds.length === 1 || kinds[0][1] >= c.filled * 0.9 ? kinds[0][0] : 'mixed';
        const out = { column: letter, header: c.header, type, filled: c.filled };
        if (c.min !== undefined) Object.assign(out, { min: c.min, max: c.max });
        const textRows = c.kinds.text || 0;
        if (type === 'text' && textRows >= MIN_ROWS_FOR_CATEGORIES && c.values.size <= MAX_CATEGORIES) {
            out.categories = [...c.values.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} (${n})`);
        }
        return out;
    });
    return { name, rows: lastRow, usedRange: lastRow ? `A1:${lastCol}${lastRow}` : null, columns };
}

module.exports = { tabOutline, MAX_CATEGORIES };
