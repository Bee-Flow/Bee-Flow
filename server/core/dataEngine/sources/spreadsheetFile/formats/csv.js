/**
 * CSV, read and edited BYTE-FAITHFULLY — a hand parser, no dependency.
 *
 * A CSV in someone's Drive is theirs: the delimiter their Excel chose (`;`
 * on a Dutch machine, `\t` from "Unicode text", `,` elsewhere), the BOM their
 * tool wrote, CRLF or LF, windows-1252 from an older export, a decimal comma.
 * None of that may change because Bee Flow edited one row. So the file is
 * SNIFFED once (`sniff`), parsed into records that remember their original
 * bytes (`{ raw, fields }`), and on write-back every untouched record emits
 * its `raw` unchanged — only the records that were edited, added or removed
 * are re-serialised, with the sniffed delimiter, quote, EOL and decimal, and
 * dates in the column's own spelling (`dateFormat`, found by infer.js). A
 * `diff` of the file afterwards shows exactly the rows Bee Flow touched.
 *
 * Parsing is RFC 4180: a field may be wrapped in double quotes, a wrapped
 * field may hold the delimiter or line breaks, a doubled quote is a literal
 * one. The reader stops after the row cap + one probe record and after
 * MAX_CELLS fields, so a 25 MB dump never becomes a million strings; the
 * editor parses the whole file (it has to write the whole file back).
 *
 * FORMULA-SHAPED TEXT gets a `'` prefix on write, as officegen.buildCsv does:
 * a csv has no cell types, so a text value that starts with = + - @ (or a
 * tab / CR) is the one thing this writer cannot hand a spreadsheet as text —
 * Excel evaluates it when the file is opened, and `=cmd|...` there is code
 * execution on the machine of whoever opens it. The values do not only come
 * from the file's owner typing into their own table: a routine, an App
 * Studio action or a public form writes rows too. Only text-shaped columns
 * (cells.formulaShaped): a number column's -5 is a number. The reader
 * strips that one prefix again (`'=` → `=`), so the mirror shows what was
 * typed, an echo of a read is a no-op, and a key minted on the write is
 * the key the next pass mints. Excel shows the apostrophe when it opens the
 * csv — the price of a file that is safe to double-click.
 */

'use strict';

const { SpreadsheetSourceError } = require('../errors');
const { isBlank, hasTime, partsOf, formulaShaped, FORMULA_TRIGGER_RE } = require('../cells');
const { headerText } = require('../columns');

// Sniffed in this order, so a tab-separated file is never read as a CSV.
const DELIMITERS = ['\t', ';', ',', '|'];
const SNIFF_RECORDS = 20;
const QUOTE = '"';
// Records parsed beyond the row cap, so a blank line at the cap does not hide
// the data under it (same probe as sheetjs.js).
const PROBE_ROWS = 50;
// The `'` a formula-shaped text was written with (see the header): one
// apostrophe, and only in front of a trigger character.
const QUOTE_PREFIX = "'";
const QUOTE_PREFIXED_RE = new RegExp(`^${QUOTE_PREFIX}(?=${FORMULA_TRIGGER_RE.source.slice(1)})`);

/** The cell as the mirror reads it: the write-side `'` in front of a formula trigger taken off again. */
function unprefixField(f) {
    return QUOTE_PREFIXED_RE.test(f) ? f.slice(QUOTE_PREFIX.length) : f;
}

// windows-1252's 0x80–0x9F block (the rest is Latin-1); five bytes are undefined
// and pass through as C1 controls, as the WHATWG decoder does.
const CP1252_HIGH = [
    0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const CP1252_ENCODE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

// ---------------------------------------------------------------------------
// Bytes ↔ text
// ---------------------------------------------------------------------------

/** Buffer → { text, encoding, bom } — utf-8 unless the bytes say otherwise. */
function decode(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8', bom: true };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', bom: true };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return { text: buf.subarray(2).swap16().toString('utf16le'), encoding: 'utf-16be', bom: true };
    }
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', bom: false };
    } catch {
        return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252', bom: false };
    }
}

function encodeCp1252(text) {
    const out = Buffer.alloc(text.length);
    for (let i = 0; i < text.length; i += 1) {
        const cp = text.charCodeAt(i);
        if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out[i] = cp;
        else if (CP1252_ENCODE.has(cp)) out[i] = CP1252_ENCODE.get(cp);
        else out[i] = 0x3f;                                   // '?' — a char the file's own encoding cannot hold
    }
    return out;
}

/** text → Buffer in the file's own encoding, BOM restored. */
function encode(text, { encoding = 'utf-8', bom = false } = {}) {
    if (encoding === 'utf-16le') return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
    if (encoding === 'utf-16be') return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), Buffer.from(text, 'utf16le').swap16()]);
    if (encoding === 'windows-1252') return encodeCp1252(text);
    return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * RFC-4180 records with their original text. `raw` includes the record's own
 * line ending (none on a last record the file did not terminate).
 * @returns {{ records:Array<{raw:string, fields:string[]}>, truncated:boolean }}
 */
function parseRecords(text, delimiter, { maxRecords = Infinity, maxCells = Infinity } = {}) {
    const records = [];
    let fields = [];
    let field = '';
    let quoted = false;
    let recStart = 0;
    let cellCount = 0;
    let i = 0;
    const n = text.length;
    const endRecord = (end) => {
        fields.push(field);
        cellCount += fields.length;
        records.push({ raw: text.slice(recStart, end), fields });
        fields = [];
        field = '';
        recStart = end;
    };
    for (; i < n; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch !== QUOTE) { field += ch; continue; }
            if (text[i + 1] === QUOTE) { field += QUOTE; i += 1; continue; }
            quoted = false;
            continue;
        }
        if (ch === QUOTE && field === '') { quoted = true; continue; }
        if (ch === delimiter) { fields.push(field); field = ''; continue; }
        if (ch === '\r' || ch === '\n') {
            const end = (ch === '\r' && text[i + 1] === '\n') ? i + 2 : i + 1;
            endRecord(end);
            i = end - 1;
            if (records.length >= maxRecords || cellCount >= maxCells) { i += 1; break; }
            continue;
        }
        field += ch;
    }
    const consumedAll = i >= n;
    if (consumedAll && (recStart < n)) endRecord(n);      // a last record without a line ending
    return { records, truncated: !consumedAll };
}

function isBlankRecord(rec) {
    return !rec || rec.fields.every(f => f === '' || f.trim() === '');
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

function sniffEol(text) {
    const lf = text.indexOf('\n');
    if (lf > 0 && text[lf - 1] === '\r') return '\r\n';
    if (lf >= 0) return '\n';
    return text.includes('\r') ? '\r' : '\n';
}

/**
 * The delimiter that splits the first records most CONSISTENTLY (every
 * record into the same number of fields), the widest on a tie, tab first.
 * `conclusive` is false when no delimiter splits anything (a one-column
 * file, an empty one): the ',' answered then is a default, not a finding.
 */
function sniffDelimiterDetailed(text) {
    let best = null;
    for (const d of DELIMITERS) {
        const recs = parseRecords(text, d, { maxRecords: SNIFF_RECORDS }).records.filter(r => !isBlankRecord(r));
        if (!recs.length) continue;
        const width = recs[0].fields.length;
        if (width < 2) continue;
        const consistent = recs.filter(r => r.fields.length === width).length / recs.length;
        if (!best || consistent > best.consistent || (consistent === best.consistent && width > best.width)) {
            best = { delimiter: d, consistent, width };
        }
    }
    return best ? { delimiter: best.delimiter, conclusive: true } : { delimiter: ',', conclusive: false };
}

function sniffDelimiter(text) {
    return sniffDelimiterDetailed(text).delimiter;
}

const COMMA_DECIMAL_RE = /^-?\d{1,3}(\.\d{3})*,\d+$/;
const DOT_DECIMAL_RE = /^-?\d{1,3}(,\d{3})*\.\d+$/;
// '1.000' / '1,000': a thousand to the reader (cells.parseNumberish groups
// a lone separator followed by three digits), so no evidence either way.
const GROUPED_INTEGER_RE = /^-?\d{1,3}([.,]\d{3})+$/;

/** The decimal mark the first records use; `conclusive` is false when they hold no decimal number at all. */
function sniffDecimalDetailed(records) {
    let comma = 0;
    let dot = 0;
    for (const r of records) {
        for (const f of r.fields) {
            const s = f.trim();
            if (GROUPED_INTEGER_RE.test(s)) continue;
            if (COMMA_DECIMAL_RE.test(s)) comma += 1;
            else if (DOT_DECIMAL_RE.test(s)) dot += 1;
        }
    }
    return { decimal: comma > dot ? ',' : '.', conclusive: comma + dot > 0 };
}

function sniffDecimal(records) {
    return sniffDecimalDetailed(records).decimal;
}

/**
 * Everything the writer must reproduce: encoding, BOM, EOL, delimiter,
 * quote and decimal — `source.csv` in the mirror's source JSON.
 */
function sniff(buffer) {
    const { text, encoding, bom } = decode(buffer);
    const delimiter = sniffDelimiter(text);
    const first = parseRecords(text, delimiter, { maxRecords: SNIFF_RECORDS }).records;
    return { delimiter, quote: QUOTE, bom, eol: sniffEol(text), encoding, decimal: sniffDecimal(first) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a CSV as header + data rows — the same shape sheetjs.readSheet gives
 * (every cell a string or null; no dates, formulas or number formats to
 * report), plus `csv` = the sniffed facts.
 */
async function readSheet(buffer, { headerRow = 1, maxRows, maxCols, maxCells = Infinity }) {
    const h = Math.max(1, Number(headerRow) || 1);
    const csv = sniff(buffer);
    const { text } = decode(buffer);
    const { records, truncated: cut } = parseRecords(text, csv.delimiter, { maxRecords: h + maxRows + PROBE_ROWS, maxCells });
    const warnings = [];
    const headerRec = records[h - 1];
    if (!headerRec || isBlankRecord(headerRec)) {
        throw new SpreadsheetSourceError(422, 'header_missing',
            'The file has no header row there — pick the row that holds the column names.');
    }
    let lastHeader = -1;
    headerRec.fields.forEach((f, c) => { if (headerText(f) !== '') lastHeader = c; });
    let span = lastHeader + 1;
    if (span > maxCols) {
        warnings.push(`Only the first ${maxCols} of ${span} columns are read.`);
        span = maxCols;
    }
    const header = headerRec.fields.slice(0, span).map(f => (f === '' ? null : f));
    const rows = [];
    const rowNumbers = [];
    let lastDataRow = h;
    let beyond = false;
    for (let i = h; i < records.length; i += 1) {
        const rec = records[i];
        const cells = new Array(span).fill(null);
        let blank = true;
        for (let c = 0; c < span && c < rec.fields.length; c += 1) {
            const f = rec.fields[c];
            if (f === '') continue;
            cells[c] = unprefixField(f);
            blank = false;
        }
        if (!beyond && rec.fields.length > span && rec.fields.slice(span).some(f => f.trim() !== '')) beyond = true;
        if (blank) continue;
        rows.push(cells);
        rowNumbers.push(i + 1);
        lastDataRow = i + 1;
    }
    if (beyond) warnings.push(`Fields to the right of the last header column (${span}) are ignored.`);
    let truncated = rows.length > maxRows || (rows.length >= maxRows && cut);
    if (rows.length > maxRows) {
        rows.length = maxRows;
        rowNumbers.length = maxRows;
        lastDataRow = rowNumbers[rowNumbers.length - 1];
    }
    return {
        sheet: null, header, rows, rowNumbers,
        formulaCols: new Set(), dateCols: new Set(), numFmts: new Map(),
        lastDataRow, truncated, warnings, csv,
    };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** A Date in the column's own spelling ('dd-mm-yyyy', 'yyyy-mm-dd', …), with the clock when it has one. */
function formatDate(d, dateFormat, withTime) {
    const p = partsOf(d);
    const fmt = String(dateFormat || 'yyyy-mm-dd').toLowerCase();
    const sep = (fmt.match(/[-/.]/) || ['-'])[0];
    let date;
    if (fmt.startsWith('dd')) date = `${pad(p.d)}${sep}${pad(p.m)}${sep}${p.y}`;
    else if (fmt.startsWith('mm')) date = `${pad(p.m)}${sep}${pad(p.d)}${sep}${p.y}`;
    else date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    if (!withTime && !hasTime(d)) return date;
    return `${date} ${pad(p.H)}:${pad(p.M)}${p.S ? `:${pad(p.S)}` : ''}`;
}

/**
 * One value (the write codec's output) as the text this file spells it in.
 * @param {*} value            string | number | boolean | Date | null
 * @param {object} [column]    the columnMap entry ({ type, dateFormat })
 * @param {object} [csv]       the sniffed facts ({ decimal })
 */
function formatField(value, column = {}, csv = {}) {
    if (isBlank(value)) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') {
        const s = String(value);
        return csv.decimal === ',' ? s.replace('.', ',') : s;
    }
    if (value instanceof Date) return formatDate(value, column.dateFormat, column.type === 'datetime');
    const s = String(value);
    // A text a spreadsheet would evaluate: pinned as text the only way a csv
    // can (the header says why); the reader takes the prefix off again.
    return formulaShaped(s, column.type || 'text') ? QUOTE_PREFIX + s : s;
}

/** Quote when the field would otherwise not survive a parse. */
function quoteField(s, delimiter) {
    const needs = s.includes(delimiter) || s.includes(QUOTE) || s.includes('\r') || s.includes('\n') || /^\s|\s$/.test(s);
    return needs ? `${QUOTE}${s.replace(/"/g, '""')}${QUOTE}` : s;
}

/** Records → bytes: untouched records verbatim, touched ones re-serialised. */
function serialise(records, csv) {
    const parts = records.map((r) => (
        typeof r.raw === 'string' ? r.raw : r.fields.map(f => quoteField(f, csv.delimiter)).join(csv.delimiter) + csv.eol
    ));
    return encode(parts.join(''), csv);
}

/**
 * Apply row edits to a CSV and give back the whole file.
 *
 * Ops (row numbers are 1-based records, as a person counts lines):
 *   { op:'update', row, cells:{ [col]: value } }
 *   { op:'append', cells:{ [col]: value } }          → lands at lastDataRow + 1
 *   { op:'delete', row }
 * Updates are applied first, then deletes highest row first (so every row
 * number in the batch still refers to the file as it was read), then
 * appends at the new end.
 * `columns` maps a 0-based col to its columnMap entry (type, dateFormat).
 *
 * The DIALECT is the one sniffed from these very bytes — the row numbers
 * and column indexes in `ops` came from a read of the same bytes with the
 * same sniff, and a file re-saved with another delimiter since it was
 * linked would otherwise be parsed as one field per line and have its
 * edited rows rewritten as one field (every other column of that row
 * gone). The stored `csv` is consulted only where the sniff found nothing
 * to decide on: a one-column file for the delimiter, no decimal number in
 * the first records for the decimal mark. `expectSpan` — the header width
 * the caller located its rows and columns in — is checked against the
 * header as parsed here: a different width means the file changed shape
 * and the ops do not apply (409 spreadsheet_conflict). `maxCols` is the
 * reader's column cap, so a wider file compares at the width it was read.
 *
 * @returns {{ buffer:Buffer, appended:number[], lastDataRow:number, csv:object }}
 */
async function editInPlace(buffer, { headerRow = 1, ops = [], columns = {}, csv: known = null, expectSpan = null, maxCols = Infinity }) {
    const h = Math.max(1, Number(headerRow) || 1);
    const { text, encoding, bom } = decode(buffer);
    const delimiterSniff = sniffDelimiterDetailed(text);
    const csv = { delimiter: delimiterSniff.delimiter, quote: QUOTE, bom, eol: sniffEol(text), encoding, decimal: '.' };
    if (!delimiterSniff.conclusive && known && known.delimiter && DELIMITERS.includes(known.delimiter)) csv.delimiter = known.delimiter;
    const decimalSniff = sniffDecimalDetailed(parseRecords(text, csv.delimiter, { maxRecords: SNIFF_RECORDS }).records);
    csv.decimal = decimalSniff.decimal;
    if (!decimalSniff.conclusive && known && (known.decimal === ',' || known.decimal === '.')) csv.decimal = known.decimal;
    const { records } = parseRecords(text, csv.delimiter);
    const headerRec = records[h - 1];
    if (!headerRec || isBlankRecord(headerRec)) {
        throw new SpreadsheetSourceError(422, 'header_missing', 'The file has no header row there any more.');
    }
    let span = 0;
    headerRec.fields.forEach((f, c) => { if (headerText(f) !== '') span = c + 1; });
    if (Number.isInteger(expectSpan) && expectSpan > 0 && Math.min(span, maxCols) !== expectSpan) {
        throw new SpreadsheetSourceError(409, 'spreadsheet_conflict',
            `The file has ${span} columns, not the ${expectSpan} this row was located in — the file changed shape; try again in a moment.`);
    }
    const lastDataRowOf = () => {
        let last = h;
        for (let i = h; i < records.length; i += 1) {
            if (records[i].fields.slice(0, span).some(f => f.trim() !== '')) last = i + 1;
        }
        return last;
    };

    const touch = (rec) => { delete rec.raw; };
    const setCells = (rec, cellsByCol) => {
        for (const [colKey, value] of Object.entries(cellsByCol || {})) {
            const col = Number(colKey);
            if (!Number.isInteger(col) || col < 0 || col >= span) {
                throw new SpreadsheetSourceError(400, 'unknown_field', `Column ${colKey} is outside the header.`);
            }
            while (rec.fields.length <= col) rec.fields.push('');
            rec.fields[col] = formatField(value, columns[col] || {}, csv);
        }
        touch(rec);
    };
    const rowOf = (op) => {
        const row = Number(op.row);
        const rec = Number.isInteger(row) && row > h ? records[row - 1] : null;
        if (!rec || isBlankRecord(rec)) {
            throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Row ${op.row} is no longer in the file.`);
        }
        return rec;
    };

    const list = Array.isArray(ops) ? ops : [];
    for (const op of list.filter(o => o && o.op === 'update')) setCells(rowOf(op), op.cells);

    const deletes = list.filter(o => o && o.op === 'delete').map(o => Number(o.row)).sort((a, b) => b - a);
    for (const row of deletes) {
        rowOf({ row });
        records.splice(row - 1, 1);
    }

    const appended = [];
    for (const op of list.filter(o => o && o.op === 'append')) {
        const at = lastDataRowOf();                    // 1-based row of the last data record
        const rec = { fields: new Array(span).fill('') };
        const tail = records[records.length - 1];
        if (tail && typeof tail.raw === 'string' && !/[\r\n]$/.test(tail.raw)) {
            tail.raw += csv.eol;                       // the file did not end in a newline
        }
        if (records[at]) records[at] = rec;            // a blank record sat there: it becomes the row
        else records.push(rec);
        setCells(rec, op.cells);
        appended.push(at + 1);
    }

    return { buffer: serialise(records, csv), appended, lastDataRow: lastDataRowOf(), csv };
}

module.exports = {
    DELIMITERS, QUOTE, QUOTE_PREFIX,
    decode, encode, parseRecords, isBlankRecord, unprefixField,
    sniff, sniffDelimiter, sniffDelimiterDetailed, sniffDecimal, sniffDecimalDetailed, sniffEol,
    readSheet, formatField, formatDate, quoteField, serialise, editInPlace,
};
