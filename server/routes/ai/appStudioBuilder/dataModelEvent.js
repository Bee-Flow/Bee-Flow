/**
 * App Studio Builder — the `data_model` SSE payload.
 *
 * What the editor needs to invalidate its table/dataset/role caches the
 * moment a data tool runs: the tables with their field and LIVE row counts,
 * the datasets, and the model version the next CAS write must match.
 */

// ── Data-model plumbing ─────────────────────────────────────────────

/**
 * Row counts keyed by TABLE ID (the draftWrap/rendering convention). The
 * store's row_counts map is keyed by physical table KEY — tolerate both.
 */
function normalizeRowCounts(dataModel, counts) {
    const out = {};
    const c = (counts && typeof counts === 'object') ? counts : {};
    for (const t of (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : []) {
        if (!t || typeof t.id !== 'string') continue;
        const n = c[t.id] !== undefined ? c[t.id] : c[t.key];
        if (n !== undefined) out[t.id] = Math.max(0, parseInt(n, 10) || 0);
    }
    return out;
}

/** The `data_model` SSE payload, built from the live draftWrap state. */
function dataModelEvent(draftWrap) {
    const model = draftWrap.dataModel || {};
    const counts = draftWrap.rowCounts || {};
    const linked = draftWrap.linkedTables instanceof Map ? draftWrap.linkedTables : null;
    const tables = (Array.isArray(model.tables) ? model.tables : []).map((t) => {
        const row = {
            id: t.id,
            key: t.key,
            name: t.name,
            fieldCount: Array.isArray(t.fields) ? t.fields.length : 0,
            rowCount: Math.max(0, parseInt(counts[t.id], 10) || 0),
        };
        // Additive: a table whose rows live in a Studio datatable says so, so
        // the editor's Tables tab can show the Linked / Read-only badge the
        // moment the link tool runs.
        if (t.source && t.source.kind === 'datatable') {
            const info = linked ? linked.get(t.id) : null;
            row.linked = {
                kind: require('../../../core/dataEngine/sources').builderKindOf(info && info.managedKind),
                mode: (t.source.mode === 'readwrite') ? 'readwrite' : 'read',
                ...(info && info.missing ? { missing: true } : {}),
            };
        }
        return row;
    });
    const datasets = (Array.isArray(draftWrap.datasetIds) ? draftWrap.datasetIds : [])
        .map((d) => (d && typeof d === 'object' ? { id: d.id, name: d.name ?? null } : { id: d, name: null }));
    return { modelVersion: draftWrap.dataModelVersion ?? 0, tables, datasets };
}

module.exports = { normalizeRowCounts, dataModelEvent };
