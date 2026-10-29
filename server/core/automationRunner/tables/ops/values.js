// @typecheck strict
'use strict';
/**
 * Cell helpers shared by the table operations: numbers and text the way a
 * spreadsheet reads them, JSON scalars, column lookup and the error type.
 */

const { parseNumberish } = require('../../../dataEngine/sources/spreadsheetFile/cells');
const { resolveColumn, uniqueKey, makeColumn } = require('../../../automationModel/tableOps/columns');
const { isBlankCell } = require('../../../automationModel/tableOps/rules');

const MAX_SCALAR_CHARS = 32768;

/**
 * An Error with the stable `errorClass` run history groups on, plus the
 * operation and field it came from. Messages name columns and operations,
 * never cell values.
 * @param {string} errorClass
 * @param {string} message
 * @param {{ opId?: string, field?: string }} [where]
 */
function tableError(errorClass, message, where = {}) {
    /** @type {Error & { errorClass?: string, opId?: string, field?: string }} */
    const err = new Error(message);
    err.errorClass = errorClass;
    if (where.opId) err.opId = where.opId;
    if (where.field) err.field = where.field;
    return err;
}

/** A finite number, or null (blank, text, boolean, NaN). @param {unknown} v @returns {number|null} */
function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v === null || v === undefined || typeof v === 'boolean') return null;
    const n = parseNumberish(v);
    return Number.isFinite(n) ? n : null;
}

/** Trimmed, lower-cased text; '' for null. The grouping key of a cell. @param {unknown} v */
const foldText = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

/** A value as a JSON scalar cell: string | finite number | boolean | null. @param {unknown} v @returns {string|number|boolean|null} */
function toScalar(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.length > MAX_SCALAR_CHARS ? v.slice(0, MAX_SCALAR_CHARS) : v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (Array.isArray(v)) {
        const plain = v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
        return toScalar(plain ? v.filter((x) => x !== null).join('; ') : JSON.stringify(v));
    }
    try { return toScalar(JSON.stringify(v)); } catch { return null; }
}

/** @param {number} x @param {number} decimals */
const roundTo = (x, decimals) => {
    const f = 10 ** decimals;
    return Math.round(x * f) / f;
};

/** Order two cells: numbers by value, other text by locale, blanks last. @param {unknown} a @param {unknown} b */
function compareCells(a, b) {
    const ab = isBlankCell(a);
    const bb = isBlankCell(b);
    if (ab || bb) return ab === bb ? 0 : ab ? 1 : -1;
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== null && nb !== null) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The column a name points at, or a table_op_invalid error naming the
 * operation and field.
 * @param {{ key: string, label?: string }[]} columns
 * @param {string} name
 * @param {{ opId?: string, field?: string, alternatives?: string[] }} [where]
 */
function requireColumn(columns, name, where = {}) {
    const col = resolveColumn(columns, name, where.alternatives);
    if (col) return col;
    const available = columns.slice(0, 12).map((c) => c.key).join(', ');
    throw tableError('table_op_invalid',
        `The column "${name}" is not in the table at this point${available ? ` (columns: ${available}${columns.length > 12 ? ', ...' : ''})` : ''}.`,
        where);
}

/** Rows from a function returning an iterable, an array, or an (async) iterable.
 * @template T
 * @param {(() => Iterable<T>|AsyncIterable<T>)|Iterable<T>|AsyncIterable<T>|null|undefined} rows
 */
async function* iterate(rows) {
    const it = typeof rows === 'function' ? rows() : rows;
    if (it === null || it === undefined) return;
    yield* it;
}

/** Cooperative scheduling: await this every row; it yields to the event loop every `every` calls. */
function createTicker(/** @type {{every?: number, isCancelled?: Function}} */ { every = 2000, isCancelled } = {}) {
    let count = 0;
    return async function tick() {
        if (++count % every !== 0) return;
        await new Promise((resolve) => setImmediate(resolve));
        if (isCancelled && await isCancelled()) throw new Error('Run cancelled');
    };
}

module.exports = {
    tableError, toNumber, foldText, toScalar, roundTo, compareCells, requireColumn, iterate, createTicker,
    resolveColumn, uniqueKey, makeColumn, isBlankCell,
};
