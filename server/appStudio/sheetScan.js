/**
 * Which spreadsheet in an order package is the bill of materials — decided by
 * looking inside it, not by which file is biggest.
 *
 * "The largest sheet wins" was a stand-in for a question nobody had data for,
 * and the first package with three sheets settled it the wrong way by two
 * kilobytes: a stripped copy with three populated columns beat the real bill of
 * materials with twelve, and the step that reads quantities was handed a table
 * with no thickness in it.
 *
 * The honest question is not "which file is big" but "which file is ABOUT the
 * parts we just unpacked". A bill of materials names them; a contact list, a
 * price index and a stripped export do not. So: normalise every row to the same
 * spelling the pairing uses, and count how many of the part keys appear.
 *
 * TWO KINDS OF SHEET, and they are not interchangeable:
 *   • a bill of materials — a table to interpret (position, quantity, material,
 *     thickness under whatever headers this customer's ERP emits), and
 *   • a LINE LIST — a file whose headers already ARE the target columns
 *     ("cadfile;Material;Thickness;Quantity"), which is not something to
 *     interpret at all but something to import.
 * Reporting them separately is what lets an app skip a model call it does not
 * need, instead of paying to have an LLM read a file that was already an answer.
 *
 * Pure and dependency-free apart from the xlsx reader: the caller passes its own
 * `normalize`, so this module and the pairing can never disagree about how a
 * part number is spelled.
 */

'use strict';

// A bill of materials for 250 parts is tens of kilobytes. Anything past this is
// not a bill of materials, and reading it would be the expensive way to find out.
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
// Rows scanned per workbook. Well past any real order; a bound, not a budget.
const MAX_SCAN_ROWS = 20_000;
// How many missing articles we will name. Past this the package is wrong in a
// way a list does not help with, and the count still says how wrong.
const MAX_UNMATCHED = 50;

// The header vocabulary of a file that is already a line list. `cadfile` is the
// one that has to be there — it is the column that names a CUT FILE, which a
// bill of materials never has, because the customer's ERP does not know what we
// called the drawing. The rest only corroborate.
const LINE_LIST_KEY = ['cadfile', 'cad_file', 'cadbestand', 'snijbestand'];
const LINE_LIST_SUPPORT = [
    'quantity', 'aantal', 'qty',
    'material', 'materiaal',
    'thickness', 'dikte',
    'orientation', 'orientatie',
];

/**
 * The spelling BOTH sides are compared in.
 *
 * The caller's `normalize` decides what a part is called; this decides what
 * counts as a separator while searching for one, and it has to be blunter:
 * a bill of materials keeps "3010-009138" and "01" in two cells, a semicolon
 * CSV keeps them in one cell as "3010-009138;01", and the files call the part
 * "3010-009138-01". Folding every run of punctuation to a single hyphen makes
 * those three the same string. Applied to the key as well as to the row, so the
 * two can never drift.
 */
function searchForm(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Cell → the text it contributes. Dates and formulas degrade to their display. */
function cellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
}

/** The widest row in a parse — how we tell a real split from a failed one. */
function widestRow(sheets) {
    let width = 0;
    for (const sheet of sheets) {
        for (const row of sheet.rows) if ((row || []).length > width) width = row.length;
    }
    return width;
}

function parseWith(XLSX, buffer, options) {
    let wb;
    try {
        // raw: a CSV's "01" is a VARIANT, not the number one. Without this the
        // reader helpfully drops the leading zero and "3010-005424" + "01" stops
        // spelling the part "3010-005424-01" that the files are filed under.
        wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: true, cellFormula: false, cellHTML: false, ...options });
    } catch { return null; }
    const out = [];
    for (const name of wb.SheetNames || []) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        let rows;
        try { rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null }); } catch { continue; }
        out.push({ name, rows: (rows || []).slice(0, MAX_SCAN_ROWS) });
    }
    return out.length ? out : null;
}

/**
 * Every sheet of a workbook as arrays of cells.
 *
 * Read TWICE for one reason: a CSV exported from a Dutch or German Excel is
 * semicolon-separated, and the default reader hands that back as one fat column
 * per row. That is not merely untidy — the column count is the tie-breaker
 * between two sheets that name the same parts, so a mis-split sheet loses a
 * comparison it should win. Whichever parse splits WIDER is the one that found
 * the real delimiter; for a genuine .xlsx both parses are identical and the
 * second costs nothing but the read.
 *
 * Returns null when the bytes are not a workbook at all — a caller that cannot
 * read a file learns nothing about it, which is different from learning it is
 * uninteresting.
 */
function readWorkbook(buffer) {
    let XLSX;
    try { XLSX = require('@e965/xlsx'); } catch { return null; }
    const plain = parseWith(XLSX, buffer, {});
    const semi = parseWith(XLSX, buffer, { FS: ';' });
    if (!plain) return semi;
    if (!semi) return plain;
    return widestRow(semi) > widestRow(plain) ? semi : plain;
}

// A part number is at least this long. Shorter "keys" are noise that would
// match half a workbook — the same instinct as the pairing's six-character
// family rule.
const MIN_KEY_CHARS = 5;

/** Long enough to identify a part, and with a digit in it. */
function plausiblePart(key) {
    return typeof key === 'string' && key.length >= MIN_KEY_CHARS && /[0-9]/.test(key);
}

/**
 * WHICH COLUMN holds the part number — learned from a row that matched.
 *
 * This is the whole trick behind saying "the sheet also lists 3010-007033-01 and
 * nothing came for it". Harvesting part-number-shaped tokens from a spreadsheet
 * is hopeless: a bill of materials is wall-to-wall numbers — drawing numbers,
 * positions, lengths, an order reference — and a rule that guessed which are
 * articles would invent parts nobody ordered.
 *
 * So we never guess. One row whose article we DID receive proves which column
 * the article number lives in (and, when the number is split, which neighbour
 * completes it). Every other row is then read from that same column, which is
 * evidence rather than pattern-matching. No matching row, no claim.
 *
 * Returns { keyCol, variantCol } — variantCol is -1 when one cell was enough.
 */
function findKeyColumn(cells, key) {
    for (let c = 0; c < cells.length; c += 1) {
        const own = searchForm(cells[c]);
        if (own.length < 3 || !key.startsWith(own)) continue;
        if (own === key) return { keyCol: c, variantCol: -1 };
        const joined = searchForm(`${cells[c]} ${cells[c + 1] === undefined ? '' : cells[c + 1]}`);
        if (joined === key) return { keyCol: c, variantCol: c + 1 };
    }
    return null;
}

/** Does this header row read as the target schema rather than a customer's own? */
function looksLikeLineList(headerRow) {
    const heads = (headerRow || []).map((c) => cellText(c).trim().toLowerCase()).filter(Boolean);
    if (!heads.length) return false;
    if (!heads.some((h) => LINE_LIST_KEY.includes(h))) return false;
    return heads.filter((h) => LINE_LIST_SUPPORT.includes(h)).length >= 2;
}

/**
 * Read one spreadsheet and say what it is.
 *
 *   scanSheet(bytes, { partKeys, normalize })
 *     → { rows, columns, hits, lineList }   (or null when it cannot be read)
 *
 * `hits` counts DISTINCT part keys the sheet mentions, so a bill of materials
 * that repeats a part on two drawings does not score twice for it. `columns` is
 * the widest row that actually carries content — the tie-breaker between two
 * sheets that name the same parts, because the one with twelve filled columns
 * has the thickness and the one with three does not.
 */
function scanSheet(buffer, { partKeys = [], normalize = (x) => String(x || '').toLowerCase() } = {}) {
    if (!buffer || !buffer.length || buffer.length > MAX_SCAN_BYTES) return null;
    const sheets = readWorkbook(buffer);
    if (!sheets || !sheets.length) return null;

    const wanted = new Set([...new Set(partKeys.filter(Boolean))]
        .map((k) => searchForm(k))
        .filter(plausiblePart));
    const found = new Set();
    let rows = 0;
    let columns = 0;
    let lineList = false;
    let where = null;                 // which column the article number sits in

    const cellsOf = (row) => (row || []).map(cellText);

    for (const sheet of sheets) {
        if (!sheet.rows.length) continue;
        if (looksLikeLineList(sheet.rows[0])) lineList = true;
        for (const row of sheet.rows) {
            const cells = cellsOf(row);
            const filled = cells.reduce((last, c, i) => (c.trim() ? i + 1 : last), 0);
            if (filled > columns) columns = filled;
            if (!filled) continue;
            rows += 1;
            if (!wanted.size) continue;
            // The WHOLE row as one normalised string. A bill of materials keeps
            // the article number and its variant in two neighbouring cells
            // ("3010-009138" | "01") while the files call the part
            // "3010-009138-01" — joining the row and normalising it the same way
            // is what makes those two spellings the same string.
            const line = searchForm(normalize(cells.join(' ')));
            for (const key of wanted) {
                if (found.has(key) || !line.includes(key)) continue;
                found.add(key);
                if (!where) where = findKeyColumn(cells, key);
            }
        }
    }

    // ── What this sheet lists that we received nothing for ──────────────
    //
    // Only ever from the column a matching row proved to be the article column,
    // and only when something matched at all — an unreadable sheet must not turn
    // into a list of parts the customer never ordered.
    const unmatched = [];
    if (where) {
        const seen = new Set();
        for (const sheet of sheets) {
            for (const [i, row] of sheet.rows.entries()) {
                if (i === 0) continue;                  // the header is structure
                const cells = cellsOf(row);
                const raw = where.variantCol >= 0
                    ? `${cells[where.keyCol] || ''} ${cells[where.variantCol] || ''}`
                    : (cells[where.keyCol] || '');
                const key = searchForm(raw);
                if (!plausiblePart(key) || wanted.has(key) || seen.has(key)) continue;
                seen.add(key);
                if (unmatched.length < MAX_UNMATCHED) unmatched.push(key);
            }
        }
    }

    // The header row is structure, not data.
    return {
        rows: Math.max(0, rows - sheets.length),
        columns,
        hits: found.size,
        lineList,
        // Parts the sheet names and the package did not carry. A COUNT would be
        // a rumour: somebody has to be able to write the number back to the
        // customer, so the names are what this channel is for.
        unmatched,
        unmatchedCount: unmatched.length,
    };
}

module.exports = {
    scanSheet,
    looksLikeLineList,
    MAX_SCAN_BYTES,
    _internal: { readWorkbook, cellText, searchForm, findKeyColumn, plausiblePart },
};
