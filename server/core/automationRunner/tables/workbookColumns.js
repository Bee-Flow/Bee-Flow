// @typecheck noImplicitAny
/**
 * Column logic for the workbook reader: the keys a header row becomes, the
 * storage type of a column from the values in it, and the number reading of
 * a CSV column. Pure and synchronous: no parser, no storage.
 *
 * A column key is the row field name, so it must be unique and stable:
 * the header text trimmed with its spaces collapsed, at most 200 characters,
 * a blank header 'Column <letter>', a repeated one 'Name (2)', 'Name (3)'.
 */

'use strict';

const { isoDate, isoDateTime, parseNumberish } = require('../../dataEngine/sources/spreadsheetFile/cells');
const { columnLetter } = require('../../dataEngine/sources/spreadsheetFile/columns');

const MAX_KEY_CHARS = 200;
// What a column holds, as bits: a column's type is read from the set of kinds seen in it.
const KIND = Object.freeze({ TEXT: 1, NUMBER: 2, BOOLEAN: 4, DATE: 8, DATETIME: 16 });
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMERIC_SHARE = 0.95;
const SNIFF_RECORDS = 200;
const LEADING_ZERO_RE = /^[-+]?0\d/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A header cell as text: spaces collapsed, a Date as its ISO date. @param {unknown} cell @returns {string} */
function headerLabel(cell) {
    if (cell === null || cell === undefined) return '';
    if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : isoDate(cell);
    return String(cell).replace(/\s+/g, ' ').trim().slice(0, MAX_KEY_CHARS);
}

/**
 * The unique row keys and display labels for a header row.
 * @param {Array<unknown>} headerCells
 * @param {number} width
 * @returns {{ keys: string[], labels: string[] }}
 */
function headerKeys(headerCells, width) {
    /** @type {string[]} */
    const keys = [];
    const used = new Set();
    for (let c = 0; c < width; c += 1) {
        let label = headerLabel(headerCells[c]);
        if (!label) label = `Column ${columnLetter(c)}`;
        if (RESERVED_KEYS.has(label)) label = `${label}_`;
        let key = label;
        for (let n = 2; used.has(key); n += 1) {
            const suffix = ` (${n})`;
            key = `${label.slice(0, MAX_KEY_CHARS - suffix.length)}${suffix}`;
        }
        used.add(key);
        keys.push(key);
    }
    // The label shows what the key is: the header text, made unique the same way.
    return { keys, labels: keys.slice() };
}

/** True when a header cell holds text. @param {unknown} cell */
function hasHeaderText(cell) {
    return headerLabel(cell) !== '';
}

/**
 * A Date as the ISO string the table keeps: the wall clock as UTC, a date when there is no time.
 * @param {Date} d
 */
function dateToIso(d) {
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    return { value: midnight ? isoDate(d) : isoDateTime(d), kind: midnight ? KIND.DATE : KIND.DATETIME };
}

/**
 * One parsed cell as a table value and the kind it counts as.
 * @param {unknown} v  string | number | boolean | Date | null
 * @returns {{ value: string|number|boolean|null, kind: number }}
 */
function scalarOf(v) {
    if (v === null || v === undefined) return { value: null, kind: 0 };
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? { value: null, kind: 0 } : dateToIso(v);
    if (typeof v === 'number') return Number.isFinite(v) ? { value: v, kind: KIND.NUMBER } : { value: null, kind: 0 };
    if (typeof v === 'boolean') return { value: v, kind: KIND.BOOLEAN };
    const s = String(v);
    return s === '' ? { value: null, kind: 0 } : { value: s, kind: KIND.TEXT };
}

/**
 * The storage type of a column from the kinds seen in it.
 * @param {number} mask
 */
function typeOfKinds(mask) {
    if (!mask) return 'empty';
    if (mask === KIND.TEXT) return 'text';
    if (mask === KIND.NUMBER) return 'number';
    if (mask === KIND.BOOLEAN) return 'boolean';
    if (mask === KIND.DATE) return 'date';
    if (mask === KIND.DATETIME || mask === (KIND.DATE | KIND.DATETIME)) return 'datetime';
    return 'mixed';
}

/**
 * @param {string[]} keys
 * @param {string[]} labels
 * @param {ArrayLike<number>} masks
 * @returns {Array<{ key: string, label: string, type: string }>}
 */
function buildColumns(keys, labels, masks) {
    return keys.map((key, i) => ({ key, label: labels[i], type: typeOfKinds(masks[i]) }));
}

/**
 * 'YYYY-MM-DD' that is a real calendar day.
 * @param {string} s
 */
function isCalendarDate(s) {
    const m = ISO_DATE_RE.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * A CSV field as a number under the file's own decimal mark, or null. A lone
 * separator that cannot be the file's decimal mark ("12,5" in a file that
 * writes "12.5") is left as text rather than guessed at.
 * @param {string} text
 * @param {'.'|','} decimal
 */
function csvNumber(text, decimal) {
    const s = text.trim();
    if (!s) return null;
    const other = decimal === '.' ? ',' : '.';
    if (s.includes(other) && !s.includes(decimal) && !/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return null;
    const n = parseNumberish(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * Decide, per CSV column, whether it is a number column, and convert it. A
 * column is numeric when at least 95% of its filled cells read as numbers and
 * none of them has a leading zero (0123 is a code, not 123). Dates in the ISO
 * form are only classified, never rewritten.
 *
 * @param {Array<Array<string|null>>} rows  mutated in place
 * @param {number} width
 * @param {'.'|','} decimal
 * @returns {Uint8Array} the kind mask of every column
 */
function convertCsvColumns(rows, width, decimal) {
    const masks = new Uint8Array(width);
    for (let c = 0; c < width; c += 1) {
        let filled = 0;
        let numeric = 0;
        let zeroLed = false;
        let dates = 0;
        for (const row of rows) {
            const v = row[c];
            if (v === null || v === undefined || v === '') continue;
            filled += 1;
            if (csvNumber(v, decimal) !== null) numeric += 1;
            if (LEADING_ZERO_RE.test(v.trim())) zeroLed = true;
            if (isCalendarDate(v)) dates += 1;
        }
        if (!filled) continue;
        if (!zeroLed && numeric / filled >= NUMERIC_SHARE) {
            for (const row of rows) {
                const v = row[c];
                if (typeof v !== 'string' || v === '') continue;
                const n = csvNumber(v, decimal);
                if (n !== null) { row[c] = /** @type {any} */ (n); masks[c] |= KIND.NUMBER; } else masks[c] |= KIND.TEXT;
            }
        } else if (dates === filled) {
            masks[c] = KIND.DATE;
        } else {
            masks[c] = KIND.TEXT;
        }
    }
    return masks;
}

module.exports = {
    KIND, MAX_KEY_CHARS, SNIFF_RECORDS,
    headerLabel, headerKeys, hasHeaderText, scalarOf, typeOfKinds, buildColumns, dateToIso,
    csvNumber, convertCsvColumns, isCalendarDate,
};
