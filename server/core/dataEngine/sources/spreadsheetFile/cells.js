/**
 * One cell, both ways: what the sheet holds ↔ what the mirror stores.
 *
 * A spreadsheet has no column types — only cells, each with a value and a
 * number format. What arrives from a reader (formats/) is therefore a bag of
 * JS primitives plus one convention: a cell whose number format is a date
 * format arrives as a `Date` holding the WALL CLOCK as UTC (15 Jan 2026 13:45
 * in the sheet is `Date.UTC(2026, 0, 15, 13, 45)`), because Excel serials and
 * Google's SERIAL_NUMBER carry no timezone and neither may we invent one
 * (`serialToIso`/`isoToSerial` below are the two halves of that convention,
 * epoch 1899-12-30).
 *
 * The READ codec (`readCell`) turns such a cell into the mirror's value for
 * the column's DECLARED type — forgiving, like nextcloudTable/values.js: a
 * cell that does not fit becomes NULL (the caller counts it), never an error,
 * because a refresh that dies on one odd cell leaves the whole table stale.
 *   date      → 'YYYY-MM-DD'
 *   datetime  → wall clock as UTC ISO 'YYYY-MM-DDTHH:mm:ss.000Z'
 *   number    → number     bool → boolean     text → the raw string
 * The WRITE codec (`writeCell`) is the exact inverse — an echo of what was
 * read writes the same cell back — and IS strict (422 naming the column),
 * because a wrong value silently blanked in someone's own file is worse than
 * a refusal. It yields a JS primitive or a UTC `Date`; the format writers
 * turn a Date into a serial (Sheets, Graph), an exceljs date cell, or the
 * column's own text pattern (csv).
 *
 * `parseNumberish` / `parseBoolish` / `parseDateish` are the server twins of
 * agent-hub/…/AppStudio/tables/spreadsheetPaste.js — the same spellings a
 * paste accepts, so a CSV and a paste of the same sheet read alike.
 *
 * PURE: no database, no network, no timezone.
 */

'use strict';

const { SpreadsheetSourceError } = require('./errors');

// Day 0 of the 1900 date system as Excel, LibreOffice and Google Sheets all
// count it (the phantom 29 Feb 1900 puts day 1 on 31 Dec 1899 — hence the 30th).
const EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
// Serials below this fall before 1 March 1900, where Excel's leap-year bug
// shifts the count by one day. Business data never gets there; the shift is
// honoured so the few that do still round-trip.
const LEAP_BUG_SERIAL = 61;

const YES = new Set(['yes', 'y', 'true', '1', 'x', 'ja', 'waar', 'wel', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'nee', 'onwaar', 'niet', 'off']);

// Excel, LibreOffice and Sheets parse a string starting with = + - @ (or a
// tab / CR) as a FORMULA when it is typed or imported as a plain value —
// and `=cmd|...` in someone's file is code execution on the machine that
// opens it. The rule is shared by every writer that cannot type a cell as
// text (csv: a `'` prefix), or must (Graph: the `@` number format).
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const TYPED_AS_NUMBERISH = ['number', 'date', 'datetime', 'bool'];

const pad = (n) => String(n).padStart(2, '0');

function isBlank(v) {
    return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
}

/** The wall-clock parts of a UTC Date. */
function partsOf(d) {
    return {
        y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
        H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(),
    };
}

function hasTime(d) {
    return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0;
}

function isoDate(d) {
    const p = partsOf(d);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function isoDateTime(d) {
    const p = partsOf(d);
    return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.H)}:${pad(p.M)}:${pad(p.S)}.000Z`;
}

/**
 * An Excel/Sheets serial → UTC wall-clock Date, rounded to the second (a
 * serial is a double; 13:45:30 comes back as 13:45:29.9999… otherwise).
 */
function serialToDate(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n)) return null;
    const days = n < LEAP_BUG_SERIAL ? n + 1 : n;
    const ms = Math.round((EPOCH_MS + days * MS_PER_DAY) / 1000) * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Serial → ISO. A whole day gives 'YYYY-MM-DD'; a fractional serial gives the
 * wall clock as a UTC ISO string. `{ time: true }` forces the long form.
 */
function serialToIso(serial, { time = false } = {}) {
    const d = serialToDate(serial);
    if (!d) return null;
    return (time || hasTime(d)) ? isoDateTime(d) : isoDate(d);
}

/** ISO date/datetime (or a UTC Date) → serial, the exact inverse. */
function isoToSerial(value) {
    const d = value instanceof Date ? value : parseIsoUtc(value);
    if (!d) return null;
    const serial = (d.getTime() - EPOCH_MS) / MS_PER_DAY;
    return serial < LEAP_BUG_SERIAL ? serial - 1 : serial;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±hh:mm]' → UTC Date (wall clock when no zone). */
function parseIsoUtc(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const s = String(value ?? '').trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (!m) return null;
    const date = calendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!date) return null;
    const H = m[4] === undefined ? 0 : Number(m[4]);
    const M = m[5] === undefined ? 0 : Number(m[5]);
    const S = m[6] === undefined ? 0 : Number(m[6]);
    const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
    if (H > 23 || M > 59 || S > 59) return null;
    let t = Date.UTC(date.y, date.m - 1, date.d, H, M, S, ms);
    if (m[8] && m[8] !== 'Z') {
        // An explicit offset is honoured; the result is the instant, in UTC.
        const sign = m[8][0] === '-' ? -1 : 1;
        const [oh, om] = m[8].slice(1).replace(':', '').match(/\d{2}/g).map(Number);
        t -= sign * (oh * 60 + om) * 60_000;
    }
    return new Date(t);
}

function calendarDate(y, m, d) {
    if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1) return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return { y, m, d };
}

/**
 * Read a number the way a spreadsheet wrote it: currency signs and thousands
 * separators dropped, both decimal conventions accepted. When a value holds
 * both separators the LAST one is the decimal point ("1.234,56" and
 * "1,234.56" are the same amount); a lone comma is a decimal point unless it
 * groups three digits at a time. A leading zero ("0123") is an identifier,
 * not a number, and stays text — so is anything with mixed grouping.
 */
function parseNumberish(text) {
    if (typeof text === 'number') return text;
    if (typeof text === 'boolean' || text instanceof Date) return NaN;
    let s = String(text ?? '').trim().replace(/\s/g, '').replace(/^[€$£]|[€$£]$/g, '');
    if (!s) return NaN;
    let percent = false;
    if (/%$/.test(s)) { percent = true; s = s.slice(0, -1); }
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
        const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
        const grouping = decimal === ',' ? '.' : ',';
        const groupRe = grouping === '.' ? /^-?\d{1,3}(\.\d{3})+,\d+$/ : /^-?\d{1,3}(,\d{3})+\.\d+$/;
        if (!groupRe.test(s)) return NaN;
        s = s.split(grouping).join('').replace(decimal, '.');
    } else if (hasComma) {
        if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.split(',').join('');
        else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
        else return NaN;
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
        s = s.split('.').join('');
    }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    if (/^-?0\d/.test(s)) return NaN;               // '0123' is an identifier
    const n = Number(s);
    return Number.isFinite(n) ? (percent ? n / 100 : n) : NaN;
}

/**
 * Would a spreadsheet read this written value as a formula? Only a STRING
 * in a text-shaped column: a number column's -5 is a number, a date's
 * serial is a serial. A value that came in typed (a number, a Date) can
 * never be parsed as one.
 */
function formulaShaped(value, type) {
    return !TYPED_AS_NUMBERISH.includes(type) && typeof value === 'string' && FORMULA_TRIGGER_RE.test(value);
}

/** yes/no/true/false/ja/nee/waar/onwaar/wel/niet (and x, 1, 0) → boolean, else null. */
function parseBoolish(text) {
    if (typeof text === 'boolean') return text;
    if (typeof text === 'number') return text === 1 ? true : text === 0 ? false : null;
    const s = String(text ?? '').trim().toLowerCase();
    if (!s) return null;
    if (YES.has(s)) return true;
    if (NO.has(s)) return false;
    return null;
}

/**
 * Read a date the way a spreadsheet wrote it: ISO first, then the day-first
 * spellings used across Europe. A pair like 03/04 is genuinely ambiguous —
 * it is read day-first unless the first number can only be a month, OR the
 * column's own spelling is known (`dateFormat`, found by infer.js from the
 * cells that were not ambiguous): an mm/dd column reads 03/04 as 4 March.
 * Without that hint the read and write halves would disagree on every
 * ambiguous cell of a US-style column — the csv writer spells 2026-03-04 as
 * '03/04/2026' there, and a day-first read of it would hand back 3 April.
 * Returns 'YYYY-MM-DD' or null; `{ format }` in the second result tells the
 * csv writer which spelling the column used, and `ambiguous` says the
 * spelling was a GUESS (both numbers could be the month) — infer.js lets
 * only the cells that were not decide a column's spelling.
 */
function parseDateishDetailed(text, dateFormat = null) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (iso) {
        const c = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
        return c ? { date: `${c.y}-${pad(c.m)}-${pad(c.d)}`, format: 'yyyy-mm-dd', ambiguous: false } : null;
    }
    const parts = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/.exec(s);
    if (parts) {
        const a = Number(parts[1]);
        const b = Number(parts[3]);
        const year = Number(parts[4]);
        const sep = parts[2];
        const hint = String(dateFormat || '').toLowerCase();
        const monthFirst = hint.startsWith('mm') && !hint.startsWith('dd');
        let c;
        let format;
        let ambiguous = false;
        if (a > 12 && b <= 12) { c = calendarDate(year, b, a); format = `dd${sep}mm${sep}yyyy`; }
        else if (b > 12 && a <= 12) { c = calendarDate(year, a, b); format = `mm${sep}dd${sep}yyyy`; }
        else if (monthFirst) { c = calendarDate(year, a, b); format = `mm${sep}dd${sep}yyyy`; ambiguous = true; }
        else { c = calendarDate(year, b, a); format = `dd${sep}mm${sep}yyyy`; ambiguous = true; }
        return c ? { date: `${c.y}-${pad(c.m)}-${pad(c.d)}`, format, ambiguous } : null;
    }
    return null;
}

function parseDateish(text, dateFormat = null) {
    const r = parseDateishDetailed(text, dateFormat);
    return r ? r.date : null;
}

/** A date + 'HH:mm[:ss]' cell → UTC wall-clock ISO, or null. `dateFormat` as for parseDateish. */
function parseDatetimeish(text, dateFormat = null) {
    if (text instanceof Date) return Number.isNaN(text.getTime()) ? null : isoDateTime(text);
    const s = String(text ?? '').trim();
    if (!s) return null;
    const isoFull = parseIsoUtc(s);
    if (isoFull) return isoDateTime(isoFull);
    const m = /^(.*?)[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    const date = parseDateish(m ? m[1] : s, dateFormat);
    if (!date) return null;
    if (!m) return `${date}T00:00:00.000Z`;
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    const ss = m[4] === undefined ? 0 : Number(m[4]);
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return `${date}T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`;
}

/** Excel's `z` number format → the coarse format the columnMap remembers. */
function formatOfNumFmt(numFmt) {
    const z = String(numFmt || '');
    if (!z || z === 'General') return null;
    if (/%/.test(z)) return 'percent';
    if (/[€$£¥]|\[\$/.test(z)) return 'currency';
    return null;
}

// ---------------------------------------------------------------------------
// The read codec
// ---------------------------------------------------------------------------

/**
 * What the mirror stores for one cell.
 * @param {*} raw          what the reader gave: string | number | boolean | Date | null
 * @param {object} entry   the columnMap entry ({ type, dateFormat? })
 * @returns {*}            the value for the declared type, or null when it does not fit
 */
function readCell(raw, entry) {
    if (isBlank(raw)) return null;
    const type = (entry && entry.type) || 'text';
    const dateFormat = (entry && entry.dateFormat) || null;
    switch (type) {
        case 'number': {
            if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
            if (typeof raw === 'string') { const n = parseNumberish(raw); return Number.isFinite(n) ? n : null; }
            return null;
        }
        case 'bool':
            return parseBoolish(raw);
        case 'date': {
            if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : isoDate(raw);
            if (typeof raw === 'number') { const d = serialToDate(raw); return d ? isoDate(d) : null; }
            if (typeof raw === 'string') {
                const s = raw.trim();
                const dt = parseIsoUtc(s);
                if (dt) return isoDate(dt);
                const m = /^(.*?)[T\s]+\d{1,2}:\d{2}/.exec(s);
                return parseDateish(m ? m[1] : s, dateFormat);
            }
            return null;
        }
        case 'datetime': {
            if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : isoDateTime(raw);
            if (typeof raw === 'number') { const d = serialToDate(raw); return d ? isoDateTime(d) : null; }
            if (typeof raw === 'string') return parseDatetimeish(raw, dateFormat);
            return null;
        }
        case 'text':
        case 'richtext':
        case 'select':
        default: {
            if (typeof raw === 'string') return raw;
            if (typeof raw === 'number') return String(raw);
            if (typeof raw === 'boolean') return raw ? 'true' : 'false';
            if (raw instanceof Date) return hasTime(raw) ? isoDateTime(raw) : isoDate(raw);
            if (typeof raw === 'object') return JSON.stringify(raw);
            return String(raw);
        }
    }
}

// ---------------------------------------------------------------------------
// The write codec
// ---------------------------------------------------------------------------

function reject(entry, why) {
    const title = (entry && (entry.header || entry.key)) || 'column';
    return new SpreadsheetSourceError(422, 'spreadsheet_rejected', `${title}: ${why}`, { detail: why });
}

/** Is this Date at 00:00:00.000 on the SERVER's own clock (what postgres-date makes of a DATE)? */
function isLocalMidnight(d) {
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/**
 * The calendar day a Date instance names, as a UTC-midnight Date. Two kinds
 * of Date reach the write codec: the codec's own (a reader's cell, a UTC
 * wall clock — read on the UTC clock) and a pg DATE (node-pg has no parser
 * for OID 1082 by default, so postgres-date does `new Date(y, m, d)`:
 * midnight in the SERVER's zone, which under TZ=Europe/Amsterdam is 23:00Z
 * of the day BEFORE). The pg shape is read on the local clock — the same
 * rule writeThrough.dateKeys applies when it compares — and only that
 * shape: a genuine instant with a clock keeps its UTC day, as before.
 */
function calendarDayOf(d) {
    const pgShape = !hasTime(d) ? false : isLocalMidnight(d);
    return pgShape
        ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
        : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * What goes into the sheet for one value set in Bee Flow: a primitive, a UTC
 * wall-clock Date, or null (clears the cell). Throws a 422 for a value the
 * column's declared type cannot hold.
 */
function writeCell(value, entry) {
    if (isBlank(value)) return null;
    const type = (entry && entry.type) || 'text';
    const dateFormat = (entry && entry.dateFormat) || null;
    switch (type) {
        case 'number': {
            const n = typeof value === 'number' ? value : parseNumberish(value);
            if (!Number.isFinite(n)) throw reject(entry, `"${value}" is not a number`);
            return n;
        }
        case 'bool': {
            const b = parseBoolish(value);
            if (b === null) throw reject(entry, `"${value}" is not yes or no`);
            return b;
        }
        case 'date': {
            if (value instanceof Date) {
                if (Number.isNaN(value.getTime())) throw reject(entry, `"${value}" is not a date (YYYY-MM-DD)`);
                return calendarDayOf(value);
            }
            let d = parseIsoUtc(String(value).trim());
            if (!d) { const s = parseDateish(value, dateFormat); d = s ? parseIsoUtc(s) : null; }
            if (!d) throw reject(entry, `"${value}" is not a date (YYYY-MM-DD)`);
            return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        }
        case 'datetime': {
            const iso = parseDatetimeish(value, dateFormat);
            if (!iso) throw reject(entry, `"${value}" is not a date and time`);
            return new Date(iso);
        }
        case 'text':
        case 'richtext':
        case 'select':
        default:
            if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
            if (value instanceof Date) return hasTime(value) ? isoDateTime(value) : isoDate(value);
            return String(value);
    }
}

module.exports = {
    EPOCH_MS,
    FORMULA_TRIGGER_RE,
    isBlank,
    formulaShaped,
    serialToDate,
    serialToIso,
    isoToSerial,
    parseIsoUtc,
    parseNumberish,
    parseBoolish,
    parseDateish,
    parseDateishDetailed,
    parseDatetimeish,
    formatOfNumFmt,
    isoDate,
    isoDateTime,
    hasTime,
    partsOf,
    readCell,
    writeCell,
};
