/**
 * One Nextcloud row → one mirror row: `{ id, values }`.
 *
 * `id` is Nextcloud's row id as a string (index.js says why). Every cell is
 * translated through values.cellToLocal with the columnMap entry for its
 * column; the two-pass derivation itself (source columns, then the derived
 * `match`/`label` columns from the sync's indexes) is every mirror's and
 * lives in ../mirror/rows.deriveRow — this file only knows how to find a
 * Nextcloud cell: by column id in the row's `data` list.
 */

'use strict';

const { deriveRow, fieldsByIdOf } = require('../mirror/rows');
const { cellToLocal } = require('./values');

/**
 * @param {object} ncRow                {id, data:[{columnId, value}]}
 * @param {object} ctx                  see mirror/rows.deriveRow (readCell is supplied here)
 */
function mirrorRowFromNc(ncRow, ctx) {
    const byColumnId = new Map();
    for (const cell of Array.isArray(ncRow && ncRow.data) ? ncRow.data : []) {
        if (cell && cell.columnId !== undefined) byColumnId.set(String(cell.columnId), cell.value);
    }
    return deriveRow(String(ncRow.id), {
        ...ctx,
        readCell: (entry, field) => {
            const raw = byColumnId.has(String(entry.ncColumnId)) ? byColumnId.get(String(entry.ncColumnId)) : null;
            return cellToLocal(raw, entry, field);
        },
    });
}

module.exports = { mirrorRowFromNc, fieldsByIdOf };
