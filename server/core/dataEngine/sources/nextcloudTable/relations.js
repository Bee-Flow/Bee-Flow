/**
 * The relation indexes a refresh builds (../mirror/relations explains the
 * 'match' and 'nc' kinds, the owner-grade read and first-wins ambiguity).
 * What is Nextcloud's here is ONE thing: an 'nc' relation names its label
 * column by Nextcloud column id on the target table, and only this kind can
 * say which target mirror field holds that column.
 */

'use strict';

const mirror = require('../mirror/relations');

/** The mirror field on the target that holds Nextcloud column `ncColumnId`. */
function targetFieldForNcColumn(targetSource, ncColumnId) {
    for (const [fieldId, entry] of Object.entries((targetSource && targetSource.columnMap) || {})) {
        if (entry && !entry.derived && Number(entry.ncColumnId) === Number(ncColumnId)) return fieldId;
    }
    return null;
}

/** The label hook the shared index builder calls for an 'nc' relation. */
function labelFieldFor(rel, target) {
    return targetFieldForNcColumn(target && target.source, rel.labelNcColumnId);
}

/**
 * @param {{kind:string,id:string}} scope
 * @param {object} source    the mirror's `source` (relations + columnMap)
 * @returns {Promise<{ relationIndexes:Map, labelIndexes:Map, warnings:string[] }>}
 */
function buildRelationIndexes(scope, source) {
    return mirror.buildRelationIndexes(scope, source, { labelFieldFor });
}

module.exports = { buildRelationIndexes, targetFieldForNcColumn, labelFieldFor, ownerFilter: mirror.ownerFilter };
