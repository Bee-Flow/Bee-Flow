'use strict';
/**
 * A list of rows as a table source for the `table` step.
 *
 * A Code step (or any step that returns a list) leaves rows, not a table
 * handle. This module reads those shapes and says which columns they make:
 *   - a list of plain objects
 *   - `{ rows: [...] }` and `{ columns: [{ key, label?, type? }], rows: [...] }`
 *     (rows may be objects or arrays aligned to `columns`)
 *   - a Code step's output envelope (`{ result, logs, httpCalls }`) whose
 *     `result` is one of the above
 *   - a step output that carries the list as `.rows` (a datatable lookup)
 *
 * Pure: no storage. The step writes the rows with the table writer.
 */

const { isCodeEnvelope } = require('../../automationModel/codeOutput');
const { toScalar } = require('./ops/values');
const { scalarOf, typeOfKinds } = require('./workbookColumns');
const { COLUMN_TYPES } = require('./handle');

const SCAN_FOR_KEYS = 1000;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** The list-shaped payload of a bound value, or null when it is not one. */
function listPayload(value) {
    let v = value;
    if (isPlainObject(v) && isCodeEnvelope(v)) v = v.result;
    if (Array.isArray(v)) return { rows: v, columns: null };
    if (isPlainObject(v) && Array.isArray(v.rows)) {
        return { rows: v.rows, columns: Array.isArray(v.columns) && v.columns.length ? v.columns : null };
    }
    return null;
}

const safeKey = (k) => (RESERVED_KEYS.has(k) ? `${k}_` : k);

function declaredColumns(columns) {
    const used = new Set();
    return columns.map((c, i) => {
        const raw = typeof c === 'string' ? { key: c } : c;
        if (!raw || (typeof raw.key !== 'string' && typeof raw.key !== 'number') || String(raw.key) === '') {
            throw badList(`Column ${i + 1} has no key. Give every column a "key".`);
        }
        let key = safeKey(String(raw.key));
        for (let n = 2; used.has(key); n += 1) key = `${raw.key} (${n})`;
        used.add(key);
        return { key, source: String(raw.key), label: String(raw.label ?? raw.key), declared: COLUMN_TYPES.includes(raw.type) ? raw.type : null };
    });
}

function badList(message) {
    return Object.assign(new Error(message), { errorClass: 'table_source_invalid', field: 'source' });
}

/**
 * @param {unknown} value
 * @param {{ maxRows?: number, sample?: number }} [opts]
 * @returns {{ columns: Array<{key:string,label:string,type:string}>, rows: Array<Record<string, any>>, truncated: boolean } | null}
 *   null when the value is not list-shaped; throws (errorClass table_source_invalid
 *   or table_too_large) on rows that cannot be a table.
 */
function listToTable(value, opts = {}) {
    const payload = listPayload(value);
    if (!payload) return null;
    const { maxRows = 0, sample = 0 } = opts;
    const list = payload.rows;
    if (maxRows > 0 && list.length > maxRows && !sample) {
        throw Object.assign(new Error(`The list has ${list.length} rows, which is more than the limit of ${maxRows} (AUTOMATION_TABLE_MAX_ROWS). Cut it down in the step that makes it.`), { errorClass: 'table_too_large', field: 'source' });
    }
    const slice = sample ? list.slice(0, sample) : list;

    let decl = payload.columns ? declaredColumns(payload.columns) : null;
    const aligned = (r) => Array.isArray(r);
    if (!decl) {
        const keys = [];
        const seen = new Set();
        slice.slice(0, SCAN_FOR_KEYS).forEach((r) => {
            if (aligned(r) || !isPlainObject(r)) return;
            for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
        });
        decl = keys.map((k) => ({ key: safeKey(k), source: k, label: k, declared: null }));
    }

    const masks = new Array(decl.length).fill(0);
    const rows = slice.map((r, i) => {
        const isArr = aligned(r);
        if (!isPlainObject(r) && !(isArr && payload.columns)) {
            throw badList(`Row ${i + 1} is ${r === null ? 'empty' : isArr ? 'a list (rows as lists need "columns")' : `a ${typeof r}`}, not a record. Each row must be an object such as {"name": "Ann", "amount": 3}.`);
        }
        const row = {};
        decl.forEach((c, j) => {
            const cell = toScalar(isArr ? r[j] : r[c.source]);
            row[c.key] = cell;
            masks[j] |= scalarOf(cell).kind;
        });
        return row;
    });
    if (!decl.length && rows.length) throw badList('The rows have no fields, so there are no columns to make a table from.');

    const columns = decl.map((c, j) => ({ key: c.key, label: c.label, type: c.declared || typeOfKinds(masks[j]) }));
    return { columns, rows, truncated: !!sample && list.length > sample };
}

module.exports = { listToTable, listPayload };
