// @typecheck
/**
 * What a datatable step's cell values become before they are written.
 *
 * The step's `values` come out of bindings and templates, so a number is often
 * the string "5" and a yes/no the string "true". Postgres casts some of that
 * and refuses the rest with a message that names neither the column nor the
 * step. This module settles it BEFORE the statement: a value is turned into
 * the type of its column, or the step fails naming the column and the type
 * (never the value, which may be customer text). The step's `row` output is
 * built from the same result, so add_row, an inserting save_row and an
 * updating save_row all return the same types.
 */
'use strict';

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

const YES = new Set(['true', 't', 'yes', 'y', 'on', '1']);
const NO = new Set(['false', 'f', 'no', 'n', 'off', '0']);

const err = (key, wanted) => {
    /** @type {import('./runnerError.types').RunnerError} */
    const e = new Error(`The value for the column "${key}" is not ${wanted}, so the row was not written.`);
    e.errorClass = 'datatable_type_mismatch';
    return e;
};

/** The calendar date really exists (2026-02-30 does not). */
function realDate(text) {
    const [y, m, d] = text.slice(0, 10).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && !Number.isNaN(Date.parse(text));
}

/** One cell → the type of its column. Throws datatable_type_mismatch. */
function normaliseCell(field, value) {
    if (value === undefined || value === null) return null;
    const type = field && field.type;
    const key = field && field.key;
    // An empty string in a typed column is "no value", the way a form sends it.
    if (value === '' && (type === 'number' || type === 'date' || type === 'datetime' || type === 'bool')) return null;
    if (type === 'number') {
        const n = typeof value === 'number' ? value
            : (typeof value === 'string' && NUMERIC_RE.test(value.trim()) ? Number(value.trim()) : NaN);
        if (!Number.isFinite(n)) throw err(key, 'a number');
        if (field.subtype === 'integer' && !Number.isInteger(n)) throw err(key, 'a whole number');
        return n;
    }
    if (type === 'bool') {
        if (typeof value === 'boolean') return value;
        const s = String(value).trim().toLowerCase();
        // What Postgres' boolean input accepts ('on' is what an HTML checkbox posts).
        if (value === 1 || YES.has(s)) return true;
        if (value === 0 || NO.has(s)) return false;
        throw err(key, 'true or false');
    }
    if (type === 'date' || type === 'datetime') {
        if (typeof value !== 'string' || !DATE_RE.test(value.trim()) || !realDate(value.trim())) {
            throw err(key, type === 'date' ? 'a date (YYYY-MM-DD)' : 'a date and time');
        }
        return value.trim();
    }
    return value;
}

/** Every cell of `values`, normalised; a key the table does not know passes through. */
function normaliseCells(tableMeta, values) {
    const fields = new Map((Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields : []).map(f => [f.key, f]));
    const out = {};
    for (const [k, v] of Object.entries(values)) out[k] = fields.has(k) ? normaliseCell(fields.get(k), v) : v;
    return out;
}

module.exports = { normaliseCell, normaliseCells };

/** @typedef {{ key: string, type?: string, subtype?: string }} DatatableCellField */
