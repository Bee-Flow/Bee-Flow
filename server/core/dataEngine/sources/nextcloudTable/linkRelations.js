/**
 * The relations a link request declares, in Nextcloud-native terms (table and
 * column ids), turned into per-mirror declared relations. Extracted from
 * ./link.js, which re-exports resolveDeclared.
 */

'use strict';

const columns = require('./columns');

/**
 * Turn the request's Nextcloud-native relation triples into per-mirror
 * declared relations (columns.js shape). A side that names a table not in
 * this call or this scope is a warning, not a failure.
 */
function resolveDeclared(relations, created, siblings) {
    const byTable = new Map();
    const warnings = [];
    const mirrorByNcTable = new Map();
    for (const m of siblings.byId.values()) {
        if (m.source && !m.source.ncViewId && m.source.ncTableId) mirrorByNcTable.set(Number(m.source.ncTableId), m);
    }
    for (const { table } of created) {
        if (table.source && !table.source.ncViewId) mirrorByNcTable.set(Number(table.source.ncTableId), table);
    }
    for (const rel of Array.isArray(relations) ? relations : []) {
        const from = rel && rel.from, to = rel && rel.to;
        if (!from || !to || !from.ncTableId || !to.ncTableId || !from.ncColumnId || !to.ncColumnId) {
            warnings.push('A relation was skipped because it does not name both tables and both columns.');
            continue;
        }
        const fromMirror = mirrorByNcTable.get(Number(from.ncTableId));
        const toMirror = mirrorByNcTable.get(Number(to.ncTableId));
        if (!fromMirror || !toMirror) {
            warnings.push(`A relation was skipped because one of its tables (${from.ncTableId} → ${to.ncTableId}) is not linked here.`);
            continue;
        }
        // Field ids are derived from column ids, so they can be named before
        // the columns are read — the type code still has to be guessed from
        // the target column, which the sync verifies on its first pass.
        const localFieldId = guessFieldId(fromMirror, from.ncColumnId);
        const targetFieldId = guessFieldId(toMirror, to.ncColumnId);
        if (!localFieldId || !targetFieldId) {
            warnings.push('A relation was skipped because one of its columns could not be identified.');
            continue;
        }
        const list = byTable.get(fromMirror.id) || [];
        list.push({
            targetDatatableId: toMirror.id, targetKey: toMirror.key, targetName: toMirror.name,
            localFieldId, targetFieldId,
        });
        byTable.set(fromMirror.id, list);
    }
    return { byTable, warnings };
}

/**
 * The mirror field for a Nextcloud column id — from the columnMap when the
 * mirror has one, else by asking columns.js for the id a text column would
 * get (the common case for a match key). Returns null when unknowable.
 */
function guessFieldId(mirror, ncColumnId) {
    for (const [fieldId, entry] of Object.entries((mirror.source && mirror.source.columnMap) || {})) {
        if (entry && !entry.derived && Number(entry.ncColumnId) === Number(ncColumnId)) return fieldId;
    }
    const type = mirror._ncColumnTypes && mirror._ncColumnTypes[ncColumnId];
    if (!type) return null;
    // A match on a relation column makes no sense (its value is a row id of
    // yet another table); the sync would refuse it, so refuse it here.
    if (type === 'relation') return null;
    return columns.fieldIdFor(ncColumnId, type);
}

module.exports = { resolveDeclared, guessFieldId };
