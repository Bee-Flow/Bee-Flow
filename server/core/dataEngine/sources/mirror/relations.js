/**
 * The indexes a refresh builds over a mirror's RELATION TARGETS, so every
 * fetched row can be given its derived columns in memory (rows.js):
 *
 *   'match'  fieldId → Map<target column value, target row id>
 *            "the supplier whose Naam equals this invoice's Leverancier"
 *   'nc'     fieldId → Map<target row id, label>
 *            "what row 7 of the suppliers table is called"
 *
 * Both are one whole-table read of ONE column on the target
 * (queryCompiler.compileKeyValues), at OWNER grade: the relation is the
 * table's own rule, exactly as retention is (jobs/datatableRetention.js
 * ownerFilter), and there is no viewer here. A target that is gone, has no
 * columns, or lacks the named column yields an EMPTY index and a warning —
 * the pass goes on and the derived column is NULL, because a broken link is
 * a fact for the owner to fix, not a reason to leave the whole copy stale.
 *
 * Ambiguity is resolved FIRST WINS and counted: two suppliers named "Acme"
 * make the match arbitrary, and the warning is what tells the owner that.
 *
 * The 'match' kind is every source's; the 'nc' kind is Nextcloud's own
 * relation column, whose label column is named in Nextcloud's terms — so
 * WHICH target field holds the label is the adapter's to say, through the
 * `labelFieldFor(rel, targetTable)` hook. A target may be a mirror of
 * another kind: the match index reads a datatable column, not a source.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const { synthesizeAccess } = require('../../../../auth/datatableAccess');
const { ownerFilter } = require('./access');
const { PG } = require('./constants');

/** (id, value) pairs of ONE column of a mirror in this scope, or null when unreadable. */
async function readColumn(scope, targetDatatableId, fieldId) {
    const table = await datatableStore.getDatatable(targetDatatableId, scope);
    if (!table) return { rows: null, why: 'target table is gone' };
    const meta = await datatableStore.getTableMeta(scope, targetDatatableId);
    if (!meta) return { rows: null, why: 'target table has no columns' };
    const field = (meta.fields || []).find(f => f && f.id === fieldId);
    if (!field) return { rows: null, why: 'target column is gone' };
    const withAccess = { ...meta, access: synthesizeAccess(table) };
    const { sql, params } = queryCompiler.compileKeyValues(withAccess, field.key, ownerFilter(withAccess, 'read'), PG);
    const scopeKey = datatableDbStore.scopeKey(scope);
    const res = await datatableDbStore.query(scopeKey, scopeKey, sql, params);
    return { rows: res.rows || [], truncated: !!res.truncated, table, field };
}

/**
 * @param {{kind:string,id:string}} scope
 * @param {object} source    the mirror's `source` (relations + columnMap)
 * @param {object} [hooks]
 * @param {(rel:object, target:object) => string|null} [hooks.labelFieldFor]
 *   for an 'nc' relation: the target mirror's field that holds the label
 * @returns {Promise<{ relationIndexes:Map, labelIndexes:Map, warnings:string[] }>}
 */
async function buildRelationIndexes(scope, source, { labelFieldFor = null } = {}) {
    const relationIndexes = new Map();
    const labelIndexes = new Map();
    const warnings = [];
    for (const rel of (source && source.relations) || []) {
        if (!rel || !rel.fieldId || !rel.targetDatatableId) continue;
        if (rel.kind === 'match') {
            const r = await readColumn(scope, rel.targetDatatableId, rel.targetFieldId);
            const index = new Map();
            if (!r.rows) { warnings.push(`Relation via ${rel.fieldId}: ${r.why}.`); }
            else {
                let ambiguous = 0;
                for (const row of r.rows) {
                    const k = row.k === null || row.k === undefined ? null : String(row.k);
                    if (k === null) continue;
                    if (index.has(k)) { ambiguous += 1; continue; }
                    index.set(k, String(row.id));
                }
                if (ambiguous) warnings.push(`Relation via ${rel.fieldId}: ${ambiguous} value(s) match more than one row of the target; the first match is used.`);
                if (r.truncated) warnings.push(`Relation via ${rel.fieldId}: the target has more rows than could be indexed.`);
            }
            relationIndexes.set(rel.fieldId, index);
        } else if (rel.kind === 'nc') {
            // The label column is named in the source's own terms on the
            // TARGET table; the adapter finds the target mirror's field for it.
            const target = await datatableStore.getDatatable(rel.targetDatatableId, scope);
            const labelFieldId = target && typeof labelFieldFor === 'function' ? labelFieldFor(rel, target) : null;
            const index = new Map();
            if (!target) warnings.push(`Relation via ${rel.fieldId}: target table is gone.`);
            else if (!labelFieldId) warnings.push(`Relation via ${rel.fieldId}: the target no longer has its label column.`);
            else {
                const r = await readColumn(scope, rel.targetDatatableId, labelFieldId);
                if (!r.rows) warnings.push(`Relation via ${rel.fieldId}: ${r.why}.`);
                else for (const row of r.rows) index.set(String(row.id), row.k === null || row.k === undefined ? null : String(row.k));
            }
            labelIndexes.set(rel.fieldId, index);
        }
    }
    return { relationIndexes, labelIndexes, warnings };
}

module.exports = { buildRelationIndexes, readColumn, ownerFilter };
