// @typecheck
/**
 * The stored shape of a table: a gzip stream of lines. Line 1 is
 * `{"v":1,"columns":[...]}`, every following line one JSON ARRAY of cell values
 * in column order. Shared by the writer and the reader so the two cannot drift.
 */

'use strict';

const FORMAT_VERSION = 1;

/** One cell as a JSON scalar: string, finite number, boolean or null. */
function serializeCell(v) {
    if (v == null) return null;
    switch (typeof v) {
        case 'string':
        case 'boolean':
            return v;
        case 'number':
            return Number.isFinite(v) ? v : null;
        case 'bigint':
            return String(v);
        default:
            break;
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    try {
        const json = JSON.stringify(v);
        return json === undefined ? null : json;
    } catch {
        return null;
    }
}

/** @param {Array<{key: string}>} columns */
function headerLine(columns) {
    return JSON.stringify({ v: FORMAT_VERSION, columns }) + '\n';
}

/** @param {Record<string, unknown>|null|undefined} row @param {string[]} keys */
function rowLine(row, keys) {
    const out = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = serializeCell(row ? row[keys[i]] : null);
    return JSON.stringify(out) + '\n';
}

/** @param {string} line @param {string[]} keys */
function parseRowLine(line, keys) {
    const arr = JSON.parse(line);
    if (!Array.isArray(arr)) throw Object.assign(new Error('The stored table is damaged.'), { errorClass: 'table_damaged' });
    const o = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = i < arr.length ? arr[i] : null;
    return o;
}

module.exports = { FORMAT_VERSION, serializeCell, headerLine, rowLine, parseRowLine };
