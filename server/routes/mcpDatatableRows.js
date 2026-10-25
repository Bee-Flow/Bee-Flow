// @typecheck
'use strict';
/**
 * What one datatable row tool call is allowed to carry, and how a failure is
 * worded (routes/mcpDatatableTools.js): the refusal of a whole call, the check
 * of one row's values against the table's columns, the sentence for a row the
 * database refused. Nothing here touches a store.
 */

/** A refusal of the whole call, in the shape the MCP layer turns into isError. */
class ToolRefusal extends Error {
    /** @param {string} message @param {string} code @param {Record<string, any>} [extra] */
    constructor(message, code, extra = {}) {
        super(message);
        this.code = code;
        this.extra = extra;
    }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Bytes of the JSON of `value`, or Infinity when it cannot be serialised. */
function jsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    } catch {
        return Infinity;
    }
}

/** The sentence for a failure that is ours to word; anything else gets a fixed one. */
function rowFailure(e) {
    if (e && (e.errorClass === 'datatable_type_mismatch' || e.errorClass === 'managed_part' || e.name === 'CompileError')) return String(e.message).slice(0, 300);
    if (e && e.code === 'managed_part') return String(e.message).slice(0, 300);
    // pg SQLSTATEs. Never e.message: a unique violation quotes the value.
    if (e && e.code === '23502') return 'A required column has no value.';
    if (e && e.code === '23505') return 'This value is already in the table and the column must be unique.';
    if (e && (e.code === '22P02' || e.code === '22007' || e.code === '22003' || e.code === '22001')) return 'A value does not fit its column.';
    return 'The row could not be written.';
}

/** @param {string} datatableId */
function tableIdOf(datatableId) {
    if (typeof datatableId !== 'string' || !datatableId.trim() || datatableId.length > 200) {
        throw new ToolRefusal('datatableId is required (an id from datatables_list).', 'invalid_datatable_id');
    }
    return datatableId.trim();
}

/** A resolver refusal as a tool refusal. Not-found and not-allowed read the same. */
function asRefusal(e) {
    if (e instanceof ToolRefusal) return e;
    const c = e && e.errorClass;
    if (c === 'datatable_not_found' || c === 'datatable_forbidden' || c === 'datatable_no_org') {
        return new ToolRefusal('That datatable does not exist, or this account may not use it that way. Call datatables_list.', 'datatable_not_available');
    }
    if (c === 'datatable_identity_unavailable') return new ToolRefusal('Access to this datatable could not be decided right now. Try again.', 'identity_unavailable');
    if (c === 'datatable_no_columns') return new ToolRefusal('This datatable has no columns yet.', 'datatable_no_columns');
    if (e && e.status && e.code === 'managed_part') return new ToolRefusal(String(e.message).slice(0, 300), 'managed_part');
    if (e && e.status === 409 && e.code === 'quota_exceeded') {
        return new ToolRefusal(String(e.message).slice(0, 300), 'quota_exceeded', { limit: e.limit, used: e.used });
    }
    return null;
}

// ── Validation of one row's values ──────────────────────────────────────────

/**
 * Check `values` against the table's columns. `{ values }` (cells in the type
 * of their column) or `{ error }`. `partial` is an update patch: a required
 * column may be absent, but it may not be set to nothing.
 *
 * @typedef {{ key?: string, type?: string, required?: boolean, default?: unknown, options?: string[] }} ColumnMeta
 *
 * @param {{ systemColumns: Iterable<string>, normaliseCells: (tableMeta: { fields?: ColumnMeta[] }, values: Record<string, unknown>) => Record<string, unknown> }} deps
 * @param {{ fields?: ColumnMeta[] }} tableMeta @param {unknown} rawValues @param {{ partial?: boolean }} [opts]
 */
function checkValues(deps, tableMeta, rawValues, { partial = false } = {}) {
    if (!isPlainObject(rawValues)) return { error: 'A row is an object of column key to value.' };
    const values = /** @type {Record<string, unknown>} */ (rawValues);
    /** @type {Map<string, ColumnMeta>} */
    const fields = new Map((tableMeta.fields || []).filter((f) => f && f.key).map((f) => [String(f.key), f]));
    const system = new Set(deps.systemColumns);
    const keys = Object.keys(values);
    if (!keys.length && partial) return { error: 'values is empty: name the columns to change.' };

    for (const k of keys) {
        if (system.has(k)) return { error: `"${k}" is set by Bee Flow and cannot be written.` };
        const f = fields.get(k);
        if (!f) {
            const known = [...fields.keys()].slice(0, 30).join(', ');
            return { error: `Unknown column "${String(k).slice(0, 60)}". Columns: ${known}.` };
        }
        if (f.type === 'computed') return { error: `"${k}" is a computed column and cannot be written.` };
    }

    for (const [k, f] of fields) {
        if (!f.required || f.type === 'computed') continue;
        const present = Object.hasOwn(values, k);
        const v = values[k];
        const empty = v === null || v === undefined || v === '';
        if (partial ? (present && empty) : (empty && (f.default === undefined || f.default === null))) {
            return { error: `The column "${k}" is required.` };
        }
    }

    let cells;
    try {
        cells = deps.normaliseCells(tableMeta, values);
    } catch (e) {
        return { error: rowFailure(e) };
    }
    for (const [k, v] of Object.entries(cells)) {
        const f = /** @type {ColumnMeta} */ (fields.get(k));
        if (v === null || v === undefined) continue;
        if (f.type === 'select') {
            if (typeof v !== 'string' || !(f.options || []).includes(v)) return { error: `"${k}" must be one of: ${(f.options || []).slice(0, 30).join(', ')}.` };
        } else if (f.type === 'multiselect') {
            if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !(f.options || []).includes(x))) {
                return { error: `"${k}" must be a list of: ${(f.options || []).slice(0, 30).join(', ')}.` };
            }
        } else if (f.type === 'file') {
            return { error: `"${k}" is a file column; files cannot be written over MCP.` };
        } else if (typeof v === 'object') {
            return { error: `"${k}" does not take an object or a list.` };
        }
    }
    return { values: cells };
}

module.exports = { ToolRefusal, isPlainObject, jsonBytes, rowFailure, tableIdOf, asRefusal, checkValues };
