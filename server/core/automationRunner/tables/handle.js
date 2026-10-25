// @typecheck noImplicitAny
/**
 * The table handle: what a step output carries instead of the rows.
 *
 * A handle is small and safe to keep in the run history. It names the stored
 * table, lists its columns and shows the first few rows; the rest is read
 * through the table store or the paged route, never copied around.
 *
 * Rows in memory are plain objects keyed by column.key whose values are JSON
 * scalars (string, finite number, boolean or null). Dates are ISO strings.
 */

'use strict';

const { tableLimits } = require('./limits');

const TABLE_ID_RE = /^rtb_[0-9a-f]{32}$/;
const COLUMN_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'mixed', 'empty'];
const PREVIEW_COLUMNS = 50;
const PREVIEW_CELL_CHARS = 200;
const PROVENANCE_ENTRIES = 200;

/** @param {unknown} v */
function isTableHandle(v) {
    if (!v || typeof v !== 'object') return false;
    const h = /** @type {any} */ (v);
    return h.kind === 'table'
        && typeof h.tableId === 'string'
        && (h.tableId === 'dry-run' || TABLE_ID_RE.test(h.tableId))
        && Array.isArray(h.columns)
        && typeof h.rowCount === 'number';
}

/** @param {unknown} value */
function cutCell(value) {
    if (typeof value === 'string' && value.length > PREVIEW_CELL_CHARS) return value.slice(0, PREVIEW_CELL_CHARS);
    return value === undefined ? null : value;
}

/**
 * The first rows, trimmed for display: at most `previewRows` rows (0 = none), the
 * first 50 columns, string cells cut to 200 characters.
 * @param {Iterable<Record<string, unknown>>|null|undefined} rows
 * @param {Array<{key: string}>} columns
 * @param {number} [previewRows]
 * @returns {{preview: Array<Record<string, unknown>>, previewCut: boolean}}
 */
function previewOf(rows, columns, previewRows = tableLimits().previewRows) {
    const keys = columns.slice(0, PREVIEW_COLUMNS).map(c => c.key);
    /** @type {Array<Record<string, unknown>>} */
    const out = [];
    let cut = columns.length > PREVIEW_COLUMNS;
    if (rows) {
        for (const row of rows) {
            if (out.length >= previewRows) { cut = true; break; }
            /** @type {Record<string, unknown>} */
            const o = {};
            for (const k of keys) {
                const raw = row ? row[k] : null;
                const v = cutCell(raw);
                if (v !== raw && !(raw === undefined && v === null)) cut = true;
                o[k] = v;
            }
            out.push(o);
        }
    }
    return { preview: out, previewCut: cut };
}

/** @param {Record<string, unknown>|null|undefined} provenance */
function cleanProvenance(provenance) {
    if (!provenance || typeof provenance !== 'object') return null;
    const entries = Object.entries(provenance).slice(0, PROVENANCE_ENTRIES);
    if (!entries.length) return null;
    return Object.fromEntries(entries.map(([k, v]) => [String(k).slice(0, 200), String(v ?? '').slice(0, 500)]));
}

/** @param {unknown} columns */
function cleanColumns(columns) {
    return (Array.isArray(columns) ? columns : []).map(c => ({
        key: String(c.key),
        label: String(c.label ?? c.key),
        type: COLUMN_TYPES.includes(c.type) ? c.type : 'text',
    }));
}

/**
 * @param {{tableId: string, runId?: string|null, name: string, columns: any[], rowCount: number,
 *   rows?: Iterable<Record<string, unknown>>|null, expiresAt?: Date|string|null,
 *   provenance?: Record<string,string>|null, previewRows?: number}} args
 */
function buildHandle({ tableId, runId = null, name, columns, rowCount, rows = null, expiresAt = null, provenance = null, previewRows }) {
    const cols = cleanColumns(columns);
    const { preview, previewCut } = previewOf(rows, cols, previewRows);
    /**
     * @type {{ kind: string, tableId: string, runId: string|null, name: string, columns: { key: string, label: string, type: string }[],
     *   rowCount: number, preview: Array<Record<string, unknown>>, expiresAt: string|null, provenance: Record<string, string>|null, previewCut?: boolean }}
     */
    const handle = {
        kind: 'table',
        tableId,
        runId: runId || null,
        name: String(name || 'Table'),
        columns: cols,
        rowCount: Number(rowCount) || 0,
        preview,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        provenance: cleanProvenance(provenance),
    };
    if (previewCut || (Number(rowCount) || 0) > preview.length) handle.previewCut = true;
    return handle;
}

/** The handle a dry run returns: the planned columns, no rows, nothing stored. @param {{ name: string, columns?: Array<{ key: string, label?: string, type?: string }>|null }} args */
function dryRunHandle({ name, columns }) {
    return buildHandle({ tableId: 'dry-run', runId: null, name, columns: columns || [], rowCount: 0, rows: [], expiresAt: null, provenance: null });
}

module.exports = { TABLE_ID_RE, COLUMN_TYPES, isTableHandle, buildHandle, dryRunHandle, previewOf };
