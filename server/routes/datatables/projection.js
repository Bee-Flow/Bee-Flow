/**
 * What a client is allowed to see of a table.
 *
 * One projection per shape — the table row, the source block of a mirror, and
 * the `scope` descriptor the list answers with. Nothing here reaches a store:
 * it turns a row this router already holds into the object that goes over the
 * wire, and it is the only place that decides what stays server-side.
 */

'use strict';

const formAnswersDerive = require('../../automation/formAnswers/derive');
const sources = require('../../core/dataEngine/sources');
const { isDefinitionManagedKind } = require('../../core/dataEngine/dataModel/managedTables');

/** Strip anything the caller must not see from a table row. */
function publicTable(t, grade) {
    return {
        id: t.id, name: t.name, key: t.key, description: t.description,
        rowCount: t.rowCount, rowScope: t.rowScope, isPublished: t.isPublished,
        sharedGroups: t.sharedGroups, writeMode: t.writeMode,
        // The Art. 30 half. It travels with the table because the surface that
        // edits it is the same one that shows the rows: an owner deciding "how
        // long do we keep this" is looking at the data, not at a settings page.
        retentionDays: t.retentionDays, retentionField: t.retentionField,
        lastRetentionAt: t.lastRetentionAt, lawfulBasis: t.lawfulBasis,
        subjectColumn: t.subjectColumn, projectId: t.projectId,
        // NULL for an ordinary table. Non-null names the column contract the
        // platform fills in — the Studio needs it to explain why the column
        // designer refuses, and the routine editor to filter its picker.
        managedKind: t.managedKind,
        // A source mirror's two blocks, in their PUBLIC projection: where
        // the rows come from and how the last refresh went. The column map
        // and the instance id stay server-side. Null on every other table.
        source: publicSource(t.source, t.managedKind),
        sync: t.syncState || null,
        ownerUserId: t.ownerUserId, updatedAt: t.updatedAt,
        // Which tenancy this table lives in. The Studio needs it to say
        // "Personal" on the row and to replace the Sharing tab with the reason
        // there is none; the scope ID stays server-side.
        scopeKind: t.scopeKind,
        grade,
    };
}

/**
 * The part of a mirror's `source` a client may see. The envelope — the kind,
 * who linked it and when, the schedule, the relations — is every kind's and
 * is spelled out HERE; the kind's own fields (a Nextcloud table id and deep
 * link, a file and a sheet) come from its adapter. What never ships is the
 * engine's own: the column map (source column ids, option ids, header
 * hashes) and the instance id; the relations list goes without the
 * label-column ids for the same reason.
 */
function publicSource(source, managedKind = null) {
    // A form's answers table carries a source block too — the back-reference
    // to its form and its question columns — but none of a mirror's fields.
    if (source && isDefinitionManagedKind(managedKind)) return formAnswersDerive.publicSource(source);
    if (!source || !sources.isSourceKind(source.kind)) return null;
    return {
        kind: source.kind,
        ...sources.publicSourceExtras(source),
        linkedByUserId: source.linkedByUserId || null,
        linkedAt: source.linkedAt || null,
        schedule: source.schedule || null,
        refreshOnView: source.refreshOnView !== false,
        rowCap: source.rowCap || null,
        relations: (Array.isArray(source.relations) ? source.relations : []).map(r => ({
            fieldId: r.fieldId, kind: r.kind, targetDatatableId: r.targetDatatableId,
            ...(r.kind === 'nc' ? { labelFieldId: r.labelFieldId } : {}),
            ...(r.kind === 'match' ? { localFieldId: r.localFieldId, targetFieldId: r.targetFieldId } : {}),
        })),
    };
}

/** The `scope` descriptor the list returns — what a NEW table would be. */
function scopeDescriptor(scope) {
    if (!scope) return null;
    return {
        kind: scope.kind,
        id: scope.id,
        label: scope.kind === 'org' ? 'your organisation' : 'this account',
    };
}

module.exports = { publicTable, publicSource, scopeDescriptor };
