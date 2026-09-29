/**
 * One source row → one mirror row: `{ id, values }`, in two passes.
 *
 * The adapter knows how to READ a cell of its own source (`readCell(entry,
 * field)` — a Nextcloud cell by column id, a sheet cell by column index);
 * everything after that is the same for every kind: a column the map knows
 * but the row does not carry is written NULL, so a value cleared at the
 * source is cleared here; a cell for a column the map does not know is
 * ignored — the source added a column since the last schema pass, and the
 * next pass will bring it.
 *
 * Derived columns are filled from the indexes the sync built over the
 * relation targets (relations.js):
 *   'match'  values[<ref key>]   = targetIndex.get(String(local value)) ?? null
 *   'label'  values[<label key>] = labelIndex.get(String(row id))     ?? null
 * A miss is NULL, never an error: a supplier that is not in the suppliers
 * table yet is a fact about the data, not a fault in the copy.
 */

'use strict';

/**
 * @param {string} id                     the mirror row id the adapter derived
 * @param {object} ctx
 * @param {object} ctx.columnMap          source.columnMap
 * @param {Map<string,object>} ctx.fieldsById   mirror fields by id
 * @param {(entry:object, field:object) => any} ctx.readCell   the adapter's cell reader
 * @param {Map<string,Map<string,string>>} [ctx.relationIndexes]  fieldId → (value → target id) for 'match'
 * @param {Map<string,Map<string,string>>} [ctx.labelIndexes]     fieldId → (target id → label) for 'nc'
 */
function deriveRow(id, { columnMap, fieldsById, readCell, relationIndexes = new Map(), labelIndexes = new Map() }) {
    const values = {};
    // Source columns first, derived ones after — a 'match' reads the local
    // value this same loop produced.
    for (const [fieldId, entry] of Object.entries(columnMap || {})) {
        if (!entry || entry.derived) continue;
        const field = fieldsById.get(fieldId);
        if (!field) continue;
        values[field.key] = readCell(entry, field);
    }
    for (const [fieldId, entry] of Object.entries(columnMap || {})) {
        if (!entry || !entry.derived) continue;
        const field = fieldsById.get(fieldId);
        if (!field) continue;
        if (entry.derived === 'match') {
            const localField = fieldsById.get(entry.localFieldId);
            const localValue = localField ? values[localField.key] : null;
            const index = relationIndexes.get(fieldId);
            values[field.key] = (index && localValue !== null && localValue !== undefined)
                ? (index.get(String(localValue)) ?? null) : null;
        } else if (entry.derived === 'label') {
            const relField = fieldsById.get(entry.forFieldId);
            const targetId = relField ? values[relField.key] : null;
            const index = labelIndexes.get(entry.forFieldId);
            values[field.key] = (index && targetId !== null && targetId !== undefined)
                ? (index.get(String(targetId)) ?? null) : null;
        }
    }
    return { id: String(id), values };
}

/** The mirror's fields as a Map by id — what every caller of the above builds. */
function fieldsByIdOf(meta) {
    return new Map(((meta && meta.fields) || []).filter(f => f && f.id).map(f => [f.id, f]));
}

module.exports = { deriveRow, fieldsByIdOf };
