/**
 * Filling a formula across cells, as a spreadsheet's fill-down and
 * fill-right do: the relative references shift with the cell, `$`-anchored
 * parts stay, text inside quotes is never touched, and a reference pushed off
 * the sheet becomes #REF!.
 *
 * Shared by the grid (Ctrl+D / Ctrl+R in the browser) and the spreadsheet
 * assistant on the server (its fill_formula tool), so a formula filled by
 * hand and one filled by the AI read exactly alike. Zero dependencies.
 *
 * Bounds default to this product's sheet (columns A–Z, rows 1–2000).
 */

const DEFAULT_BOUNDS = Object.freeze({ maxCols: 26, maxRows: 2000 });
const REF_RE = /(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g;

const colName = (c) => String.fromCharCode(65 + c);

/**
 * The formula `raw` as it reads when filled `dCol` columns right and `dRow`
 * rows down. Anything that is not a formula is returned unchanged.
 *
 * @param {string} raw
 * @param {number} dCol
 * @param {number} dRow
 * @param {{ maxCols?: number, maxRows?: number }} [bounds]
 * @returns {string}
 */
export function shiftFormula(raw, dCol, dRow, bounds = DEFAULT_BOUNDS) {
    if (typeof raw !== 'string' || !raw.startsWith('=') || (!dCol && !dRow)) return raw;
    const maxCols = bounds.maxCols ?? DEFAULT_BOUNDS.maxCols;
    const maxRows = bounds.maxRows ?? DEFAULT_BOUNDS.maxRows;
    // Split on string literals ("…", with "" as an escaped quote) so a
    // reference-shaped word inside text stays as typed.
    return raw.split(/("(?:[^"]|"")*")/g).map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(REF_RE, (whole, colAbs, col, rowAbs, row, offset, str) => {
            // Part of a longer word (a function name such as LOG10 is followed
            // by '(' and excluded by the pattern itself).
            if (offset > 0 && /[A-Za-z0-9_.]/.test(str[offset - 1])) return whole;
            if (col.length > 1) return whole;
            const c = col.charCodeAt(0) - 65 + (colAbs ? 0 : dCol);
            const r = Number(row) + (rowAbs ? 0 : dRow);
            if (c < 0 || c >= maxCols || r < 1 || r > maxRows) return '#REF!';
            return `${colAbs}${colName(c)}${rowAbs}${r}`;
        });
    }).join('');
}

/**
 * Fill the first row of a block down over the whole block (Ctrl+D), or its
 * first column right (Ctrl+R). `raw(col, row)` reads a cell (0-based); the
 * answer is every cell the fill writes, by A1 name.
 *
 * @param {{ c0: number, r0: number, c1: number, r1: number }} block
 * @param {'down' | 'right'} direction
 * @param {(col: number, row: number) => string} raw
 * @returns {Record<string, string>}
 */
export function fillBlock(block, direction, raw) {
    const out = {};
    for (let row = block.r0; row <= block.r1; row++) {
        for (let col = block.c0; col <= block.c1; col++) {
            const fromRow = direction === 'down' ? block.r0 : row;
            const fromCol = direction === 'right' ? block.c0 : col;
            if (fromRow === row && fromCol === col) continue;
            out[`${colName(col)}${row + 1}`] = shiftFormula(raw(fromCol, fromRow) ?? '', col - fromCol, row - fromRow);
        }
    }
    return out;
}
