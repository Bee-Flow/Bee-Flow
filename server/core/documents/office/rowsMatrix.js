// @typecheck
/**
 * Rows to a cell matrix, shared by the spreadsheet writers (officegen.js re-exports
 * both helpers). Pure, no I/O.
 */

/**
 * Coerce an arbitrary value into a spreadsheet/document-safe cell value.
 * @param {boolean} [keepFormulas]
 */
function coerceCell(v, keepFormulas = false) {
    // A cell the caller marks as a formula ({ formula }) survives only where the
    // writer can emit it (create_spreadsheet); elsewhere it falls through to text.
    if (keepFormulas && v && typeof v === 'object' && !Array.isArray(v) && typeof v.formula === 'string') return { formula: v.formula };
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Normalise `rows` into a 2D matrix of cell values (first row = header).
 *  - rows of OBJECTS: columns come from `columns` (if given) else the union of
 *    keys in first-seen order; header row = the column names.
 *  - rows of ARRAYS: used verbatim; `columns` (if given) is prepended as header.
 *  - `keepFormulas`: a { formula } cell stays an object instead of becoming text.
 */
function rowsToMatrix(rows, columns, { keepFormulas = false } = {}) {
    const coerce = (v) => coerceCell(v, keepFormulas);
    const list = Array.isArray(rows) ? rows : [];
    if (list.length && list.every((r) => Array.isArray(r))) {
        const m = list.map((r) => r.map(coerce));
        if (Array.isArray(columns) && columns.length) m.unshift(columns.map(coerce));
        return m;
    }
    let cols = Array.isArray(columns) && columns.length ? columns.slice() : [];
    if (!cols.length) {
        const seen = new Set();
        for (const r of list) {
            if (r && typeof r === 'object') {
                for (const k of Object.keys(r)) {
                    if (!seen.has(k)) { seen.add(k); cols.push(k); }
                }
            }
        }
    }
    const matrix = [cols.map(coerce)];
    for (const r of list) {
        matrix.push(cols.map((c) => coerce(r && typeof r === 'object' ? r[c] : undefined)));
    }
    return matrix;
}

module.exports = { coerceCell, rowsToMatrix };
