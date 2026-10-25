// @typecheck noImplicitAny
/**
 * One sheet row → one mirror row: `{ id, values }`, or null for a row that
 * gets no id (blank, key missing, duplicate key — identity.js decided that
 * before the row reaches here).
 *
 * The two-pass derivation itself (the sheet's own columns, then the derived
 * `match` columns from the sync's indexes) is every mirror's and lives in
 * ../mirror/rows.deriveRow — this file only knows how to find a sheet cell:
 * by 0-based column index in the row's cell array, through the read codec
 * (cells.readCell) with the columnMap entry for that column. Sheets have no
 * 'label' kind.
 *
 * A non-blank cell that the declared type cannot hold lands NULL — and is
 * counted in `ctx.coercion[key]` when the caller passes that bag, so the pass
 * can tell the owner "7 values in Bedrag were not numbers" instead of
 * quietly emptying them.
 */

'use strict';

const { deriveRow, fieldsByIdOf } = require('../mirror/rows');
const { readCell, isBlank } = require('./cells');

/**
 * @param {{ id: string, rowNumber?: number, cells: unknown[] }} raw   id already derived (null = skip)
 * @param {{ columnMap?: Record<string, { col?: number, type?: string, derived?: string, localFieldId?: string, forFieldId?: string }>, fieldsById?: Map<string, { key: string, type?: string }>, relationIndexes?: Map<string, Map<string, string>>, labelIndexes?: Map<string, Map<string, string>>, coercion?: Record<string, number> }} [ctx]
 *   see mirror/rows.deriveRow (readCell is supplied here); `coercion` is { [key]: count }, incremented for cells that did not fit
 * @returns {{ id:string, values:object } | null}
 */
function rowFromSheet(raw, { columnMap, fieldsById, relationIndexes = new Map(), labelIndexes = new Map(), coercion = null } = {}) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    const cells = Array.isArray(raw.cells) ? raw.cells : [];
    return deriveRow(raw.id, {
        columnMap, fieldsById, relationIndexes, labelIndexes,
        /** @param {{ col?: number, type?: string }} entry @param {{ key: string, type?: string }} field */
        readCell: (entry, field) => {
            const cell = Number.isInteger(entry.col) && entry.col < cells.length ? cells[entry.col] : null;
            const value = readCell(cell, { ...entry, type: entry.type || field.type });
            if (value === null && !isBlank(cell) && coercion && typeof coercion === 'object') {
                coercion[field.key] = (coercion[field.key] || 0) + 1;
            }
            return value;
        },
    });
}

module.exports = { rowFromSheet, fieldsByIdOf };
