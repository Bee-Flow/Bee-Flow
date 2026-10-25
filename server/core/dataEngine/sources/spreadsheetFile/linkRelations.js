// @typecheck noImplicitAny
/**
 * The relations a link request declares between the sheets it links (and the
 * sheets linked earlier in the same scope), turned into per-mirror declared
 * relations. Extracted from ./link.js, which re-exports resolveDeclared.
 */

'use strict';

const columns = require('./columns');
const reading = require('./reading');
const { PROVIDERS } = require('./index');

/**
 * The request's `{ from:{provider,fileId,sheet,col}, to:{…} }` pairs → per-mirror
 * declared relations (columns.js shape). A side that names a sheet not in
 * this call or this scope is a warning, not a failure.
 * @param {unknown} relations
 * @param {Array<{ plan: { refKey: string, described: Array<{ col: number, headerHash: string }>, cols: Array<{ col: number, type: string, formula?: unknown }> }, table: { id: string, key: string, name: string } }>} created
 * @param {{ byRef: Map<string, { id: string, key: string, name: string, source?: { columnMap?: Record<string, { derived?: boolean, col?: number, formula?: unknown }> } }> }} siblings
 */
function resolveDeclared(relations, created, siblings) {
    const byTable = new Map();
    const warnings = [];
    const createdByRef = new Map(created.map(({ plan, table }) => [plan.refKey, { plan, table }]));

    /**
     * The mirror and the field a side names, or null.
     * @param {{ provider?: string, fileId?: string, driveId?: string, path?: string, sheet?: unknown, col?: number }} side
     */
    function sideOf(side) {
        if (!side || !PROVIDERS.includes(side.provider) || !Number.isInteger(side.col)) return null;
        let ref;
        try { ref = reading.fileRefOf(side.provider, { fileId: side.fileId, driveId: side.driveId, path: side.path }); } catch (_) { return null; }
        const sheet = side.sheet === undefined || side.sheet === null || side.sheet === '' ? '' : String(side.sheet);
        const refKey = `${reading.fileKeyOf(side.provider, { id: ref.fileId, path: ref.path })}|${sheet}`;
        const made = createdByRef.get(refKey);
        if (made) {
            const d = made.plan.described.find(x => x.col === side.col);
            const c = made.plan.cols.find(x => x.col === side.col);
            if (!d || !c || c.formula) return null;
            return { table: made.table, fieldId: columns.fieldIdFor(d.headerHash, c.type), created: true };
        }
        const existing = siblings.byRef.get(refKey);
        if (!existing) return null;
        for (const [fieldId, entry] of Object.entries((existing.source && existing.source.columnMap) || {})) {
            if (entry && !entry.derived && entry.col === side.col && !entry.formula) return { table: existing, fieldId, created: false };
        }
        return null;
    }

    for (const rel of Array.isArray(relations) ? relations : []) {
        const from = sideOf(rel && rel.from);
        const to = sideOf(rel && rel.to);
        if (!from || !to) {
            warnings.push('A relation was skipped because one of its sides does not name a linked sheet and one of its columns.');
            continue;
        }
        if (!from.created) {
            warnings.push(`A relation from "${from.table.name}" was skipped: that table was linked earlier — add the relation on its Relations tab.`);
            continue;
        }
        const list = byTable.get(from.table.id) || [];
        list.push({
            targetDatatableId: to.table.id, targetKey: to.table.key, targetName: to.table.name,
            localFieldId: from.fieldId, targetFieldId: to.fieldId,
        });
        byTable.set(from.table.id, list);
    }
    return { byTable, warnings };
}

module.exports = { resolveDeclared };
