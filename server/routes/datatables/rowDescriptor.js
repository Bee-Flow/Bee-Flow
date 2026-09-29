/**
 * The list descriptor — the one place caller-supplied query shape is accepted,
 * and the module that closes it.
 *
 * Every field key is resolved against THIS table's own declared column list,
 * every operator comes from the compiler's own FILTER_OPS, and every value is
 * bound. Nothing here can widen what the caller may see: the access predicate
 * is ANDed in by the compiler regardless of what this returns.
 */

'use strict';

const queryCompiler = require('../../core/dataEngine/queryCompiler');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');
const { bad } = require('./refusals');

/**
 * THE LIST DESCRIPTOR — the one place caller-supplied query shape is accepted.
 *
 * `?filters=`, `?sort=`, `?dir=` and `?q=` are a CLOSED DESCRIPTOR, never a
 * passthrough: every field key is resolved against THIS table's own declared
 * column list before it goes anywhere near the compiler, every operator comes
 * from the compiler's own FILTER_OPS, and every value is bound. What it cannot
 * do is widen what the caller may see — compileRecordList ANDs the access
 * predicate in regardless of what is in here, and routes/datatables.test.js
 * asserts that on the compiled SQL.
 *
 * A key that is not a column is a 400 naming it, not a 422 from the compiler:
 * the person picked a column that has since been renamed, and "unknown field:
 * status" from a SQL compiler is not an answer to that.
 */
const SEARCHABLE_TYPES = new Set(['text', 'richtext', 'select', 'multiselect']);
const MAX_LIST_FILTERS = 20;
const SORT_DIRS = new Set(['asc', 'desc']);

/** Column keys a filter or a sort may name — declared columns plus the system five. */
function filterableKeys(meta) {
    const keys = new Set(dataModel.SYSTEM_COLUMNS);
    for (const f of (meta.fields || [])) if (f && f.key) keys.add(f.key);
    return keys;
}

/** A query-string parameter that carries JSON. Malformed is a 400, never a 500. */
function jsonParam(raw, what) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch {
        return bad(`${what} must be JSON`, 'bad_descriptor');
    }
}

/** A filter value: a scalar, or a list of scalars for in/notIn/between. */
function assertFilterValue(op, value, at) {
    if (op === 'isNull' || op === 'isNotNull') return;
    if (Array.isArray(value)) {
        if (value.some(v => v !== null && typeof v === 'object')) {
            bad(`${at}: a list of values, not objects`, 'bad_filter_value');
        }
        return;
    }
    if (value !== null && typeof value === 'object') {
        bad(`${at}: a value, not an object`, 'bad_filter_value');
    }
}

function readFilters(meta, raw) {
    const parsed = jsonParam(raw, 'filters');
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) bad('filters is a list of {field, op, value}', 'bad_descriptor');
    if (parsed.length > MAX_LIST_FILTERS) {
        bad(`At most ${MAX_LIST_FILTERS} conditions`, 'too_many_filters');
    }
    const keys = filterableKeys(meta);
    return parsed.map((f, i) => {
        if (!f || typeof f !== 'object' || Array.isArray(f)) bad(`filters[${i}] must be an object`, 'bad_descriptor');
        if (!keys.has(f.field)) {
            bad(`"${f.field}" is not a column of this table`, 'unknown_filter_field');
        }
        if (!dataModel.FILTER_OPS.includes(f.op)) {
            bad(`"${f.op}" is not a test this table understands`, 'unknown_filter_op');
        }
        assertFilterValue(f.op, f.value, `filters[${i}]`);
        return { field: f.field, op: f.op, value: f.value };
    });
}

function readSort(meta, query) {
    const field = query.sort;
    if (!field) return [];
    if (!filterableKeys(meta).has(field)) {
        bad(`"${field}" is not a column of this table`, 'unknown_sort_field');
    }
    const dir = String(query.dir || 'desc').toLowerCase();
    if (!SORT_DIRS.has(dir)) bad('Sort ascending or descending', 'bad_sort_dir');
    return [{ field, dir }];
}

/**
 * `?q=` — "this word is somewhere in the row", across the table's own text-ish
 * columns. Built here rather than asked for by the client so the column list can
 * never be widened by the caller.
 */
function readSearch(meta, query) {
    const value = typeof query.q === 'string' ? query.q.trim() : '';
    if (!value) return null;
    const fields = (meta.fields || [])
        .filter(f => f && f.key && SEARCHABLE_TYPES.has(f.type))
        .map(f => f.key)
        .slice(0, MAX_LIST_FILTERS);
    // No text column means nothing to search, and an empty search must not
    // quietly become "every row" — it is refused, so the surface can say why.
    if (!fields.length) bad('This table has no text columns to search', 'nothing_to_search');
    return { value, fields };
}

function readListDescriptor(meta, query) {
    const match = query.match === undefined || query.match === '' ? 'all' : String(query.match);
    if (!queryCompiler.MATCH_MODES.includes(match)) {
        bad('Rows match all of the conditions, or any of them', 'bad_match');
    }
    return {
        filters: readFilters(meta, query.filters),
        match,
        sort: readSort(meta, query),
        search: readSearch(meta, query),
    };
}

module.exports = {
    SEARCHABLE_TYPES, MAX_LIST_FILTERS, SORT_DIRS,
    filterableKeys, jsonParam, assertFilterValue,
    readFilters, readSort, readSearch, readListDescriptor,
};
