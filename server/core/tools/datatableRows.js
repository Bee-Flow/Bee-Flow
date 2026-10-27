// @typecheck
const { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, MAX_QUERY_FILTERS, fieldMapOf } = require('./datatableToolDefs');

/** Characters of one cell the model is shown. A note field can be a novel. */
const MAX_CELL_CHARS = 400;

/** Characters of the rendered row a citation carries. */
const MAX_ROW_CHARS = 2000;

/** System columns the model may order and filter by. Timestamps only. */
const ORDERABLE_SYSTEM_COLUMNS = Object.freeze(['created_at', 'updated_at']);

/** Field types `?q=`-style search looks inside (mirrors routes/datatables.js). */
const SEARCHABLE_TYPES = Object.freeze(new Set(['text', 'richtext', 'select', 'multiselect']));

/** A read-time computed field has no physical column, so it cannot be queried. */
function isQueryable(field) {
    if (!field) return false;
    return field.type !== 'computed' || (field.computed && field.computed.stored === true);
}

/**
 * Validate the model's descriptor against the GRANTED columns.
 *
 * Returns `{descriptor}` or `{error}`. Everything the compiler would accept but
 * the grant does not name is refused here, by name, so the model corrects
 * itself instead of retrying the same hidden column.
 */
function readDescriptor(args, { columns, tableMeta }) {
    const fm = fieldMapOf(tableMeta);
    const queryable = new Set(columns.filter(k => isQueryable(fm.get(k))));
    const addressable = new Set([...queryable, ...ORDERABLE_SYSTEM_COLUMNS]);

    const rawFilters = args && args.filters;
    const filters = [];
    if (rawFilters !== undefined && rawFilters !== null) {
        if (!Array.isArray(rawFilters)) return { error: '`filters` must be a list of {field, op, value}.' };
        if (rawFilters.length > MAX_QUERY_FILTERS) {
            return { error: `At most ${MAX_QUERY_FILTERS} conditions per query.` };
        }
        for (const f of rawFilters) {
            if (!f || typeof f !== 'object' || Array.isArray(f)) {
                return { error: 'Every filter is an object {field, op, value}.' };
            }
            if (!addressable.has(f.field)) {
                return {
                    error: `"${f.field}" is not a column you may filter on here. `
                        + `Available: ${[...addressable].join(', ')}.`,
                };
            }
            filters.push({ field: f.field, op: f.op, value: f.value });
        }
    }

    const match = args && args.match === 'any' ? 'any' : 'all';

    let sort = [];
    const rawSort = args && args.sort;
    if (rawSort && typeof rawSort === 'object' && !Array.isArray(rawSort)) {
        if (!addressable.has(rawSort.field)) {
            return {
                error: `"${rawSort.field}" is not a column you may sort on here. `
                    + `Available: ${[...addressable].join(', ')}.`,
            };
        }
        sort = [{ field: rawSort.field, dir: String(rawSort.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc' }];
    }

    // Built here from the GRANTED text columns, never asked for: a search whose
    // column list came from the caller is a filter on a hidden column wearing a
    // different name.
    let search = null;
    const term = typeof (args && args.search) === 'string' ? args.search.trim() : '';
    if (term) {
        const fields = columns.filter(k => {
            const f = fm.get(k);
            return f && isQueryable(f) && SEARCHABLE_TYPES.has(f.type);
        }).slice(0, MAX_QUERY_FILTERS);
        if (fields.length === 0) {
            return { error: 'This table has no text columns to search — use filters on the listed columns instead.' };
        }
        search = { value: term, fields };
    }

    return { descriptor: { filters, match, sort, search } };
}

/** One cell, as the model should read it. Long text is cut, objects are JSON. */
function cellValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'object') {
        try { return JSON.stringify(v).slice(0, MAX_CELL_CHARS); } catch (_) { return String(v).slice(0, MAX_CELL_CHARS); }
    }
    const s = String(v);
    return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

/** The granted columns of one row, empty cells left out. */
function projectRow(row, columns) {
    const out = {};
    for (const key of columns) {
        const v = cellValue(row[key]);
        if (v === null || v === '') continue;
        out[key] = v;
    }
    return out;
}

/** The row's own name for a chip: the first granted column that has a value. */
function rowLabel(row, columns) {
    for (const key of columns) {
        const v = row[key];
        if (v === null || v === undefined || v === '') continue;
        return String(v).slice(0, 120);
    }
    return `Row ${row.id}`;
}

/** The compiler's own clamp, capped at what a context window can carry. */
function clampRowLimit(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROW_LIMIT;
    return Math.min(n, MAX_ROW_LIMIT);
}

/**
 * The row as "column: value" lines — the text a citation shows.
 *
 * Shared with the knowledge source (`core/kb/sources/datatable.js`) on purpose:
 * a row that reads one way in a synced document and another way in a live
 * citation is two shapes for one thing, which is the bug `core/kb/citation.js`
 * exists to stop happening again.
 */
function renderRowText(row, columns, deps) {
    const text = deps.renderRow(row, columns) || '';
    return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
}

module.exports = { MAX_CELL_CHARS, ORDERABLE_SYSTEM_COLUMNS, readDescriptor, projectRow, rowLabel, clampRowLimit, renderRowText };
