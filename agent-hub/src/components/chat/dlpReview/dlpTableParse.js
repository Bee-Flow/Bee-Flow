/**
 * Parses the markdown pipe-table format server/core/documents/documentParser.js
 * (`parseSpreadsheet`) produces for XLSX/XLS/CSV attachments, keeping the
 * exact character offset of every cell into the ORIGINAL flat string — the
 * same string the server's PII findings are offset against. This is what
 * lets DlpSpreadsheetRenderer show an actual `<table>` while still being
 * able to translate a click/selection back to the exact server-side offset.
 *
 * Table format (fixed, produced by parseSpreadsheet — not general markdown):
 *   | col A | col B |\n
 *   | --- | --- |\n
 *   | v1 | v2 |\n
 * A cell value never contains a literal newline (spreadsheet parser strips
 * them); a literal `|` inside a value is escaped as `\|` there but is kept
 * literal (not un-escaped) here so a cell's rendered length always equals
 * its offset span — correctness of the offset mapping matters far more than
 * the cosmetic difference of an escaped pipe showing as `\|`.
 */

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const DIVIDER_ROW = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/;

function splitRowCells(line, lineStart) {
    const cells = [];
    const firstPipe = line.indexOf('|');
    if (firstPipe === -1) return cells;
    let segStart = firstPipe + 1;
    for (let j = firstPipe + 1; j < line.length; j++) {
        if (line[j] === '|' && line[j - 1] !== '\\') {
            cells.push(_trimCell(line, segStart, j, lineStart));
            segStart = j + 1;
        }
    }
    return cells;
}

function _trimCell(line, segStart, segEnd, lineStart) {
    const raw = line.slice(segStart, segEnd);
    const leading = raw.match(/^\s*/)[0].length;
    const trailing = raw.match(/\s*$/)[0].length;
    const trimmedEnd = raw.length - trailing;
    return {
        value: raw.slice(leading, trimmedEnd),
        start: lineStart + segStart + leading,
        end: lineStart + segStart + trimmedEnd,
    };
}

/**
 * @param {string} text
 * @returns {Array<{type:'table', rows: Array<Array<{value,start,end}>>} | {type:'text', value:string, start:number, end:number}>}
 *   Blocks in document order. A caller checks `.some(b => b.type === 'table')`
 *   to decide whether this content is worth rendering as a table at all.
 */
export function parseMarkdownDocument(text) {
    const blocks = [];
    let cursor = 0;
    let currentTable = null;

    // text.split keeps every line's content; the `+1` below re-adds the '\n'
    // each split consumed so offsets stay anchored to the ORIGINAL string.
    // The very last line has no trailing '\n' — overcounting cursor past
    // text.length there is harmless since nothing reads past it.
    for (const line of text.split('\n')) {
        const lineStart = cursor;
        cursor += line.length + 1;

        if (TABLE_ROW.test(line)) {
            if (DIVIDER_ROW.test(line)) continue; // structural only — offsets already advanced above
            const cells = splitRowCells(line, lineStart);
            if (!currentTable) { currentTable = { type: 'table', rows: [] }; blocks.push(currentTable); }
            currentTable.rows.push(cells);
        } else {
            currentTable = null;
            blocks.push({ type: 'text', value: line, start: lineStart, end: lineStart + line.length });
        }
    }
    return blocks;
}

/** Does this content look like the spreadsheet parser's table format at all? */
export function looksLikeMarkdownTable(text) {
    if (!text) return false;
    let rows = 0;
    for (const line of text.split('\n')) {
        if (TABLE_ROW.test(line) && !DIVIDER_ROW.test(line)) {
            rows += 1;
            if (rows >= 2) return true;
        }
    }
    return false;
}
