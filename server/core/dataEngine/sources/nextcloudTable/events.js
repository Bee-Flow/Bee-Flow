/**
 * A Nextcloud push event → the mirror(s) it is about, patched in place.
 *
 * `tables.row.added|updated|deleted` arrives at /api/automation/events/
 * nextcloud, HMAC-signed by the connector, carrying the organisation and a
 * payload `{ tableId, rowId, values, previousValues, actor }`. The `values`
 * are keyed by Nextcloud column id and MAY BE PARTIAL (an update carries what
 * changed), so they are never trusted as the whole row: for an add or an
 * update the row is re-read from Nextcloud as the linker and upserted; for a
 * delete the mirror row goes. The change-guarded upsert (compileUpsertById)
 * means our own write-through's echo of a row lands as a no-op.
 *
 * A VIEW mirror cannot be patched from an event — whether the row is in the
 * view is the view's filter, which only Nextcloud evaluates — so it is marked
 * stale and a full pass is kicked. The same fallback covers everything that
 * goes wrong here: a linker who cannot be resolved, a row Nextcloud will not
 * hand back, a column the map has not seen. A full pass reconciles; nothing
 * is lost by falling back, only a few seconds.
 *
 * A mirror whose RELATION TARGET changed is marked stale too: its derived
 * columns (the supplier's name on the invoice) may now be wrong.
 *
 * Never throws. Runs behind the 202 the connector already got.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const queryCompiler = require('../../queryCompiler');
const accessFilter = require('../../accessFilter');
const { synthesizeAccess } = require('../../../../auth/datatableAccess');
const { resolveLinker } = require('./linkerAuth');
const ncApi = require('./ncApi');
const { mirrorRowFromNc, fieldsByIdOf } = require('./rows');
const { buildRelationIndexes } = require('./relations');

const PG = { dialect: 'pg' };
const EVENTS = new Set(['tables.row.added', 'tables.row.updated', 'tables.row.deleted']);

function ownerFilter(meta, action) {
    return accessFilter.compileAccessFilter(meta, 'owner', { id: null }, action, PG);
}

/**
 * @param {{ orgId:string, event:string, payload:object }} args
 * @returns {Promise<{ patched:number, kicked:number }>}
 */
async function onTablesEvent({ orgId, event, payload }) {
    const out = { patched: 0, kicked: 0 };
    if (!orgId || !EVENTS.has(event)) return out;
    const ncTableId = Number(payload && payload.tableId);
    const rowId = Number(payload && payload.rowId);
    if (!Number.isInteger(ncTableId)) return out;

    let mirrors = [];
    try { mirrors = await datatableStore.listNcMirrorsForTable(orgId, ncTableId); } catch { return out; }
    if (!mirrors.length) return out;

    for (const mirror of mirrors) {
        try {
            if (mirror.source && mirror.source.ncViewId) {
                await fallback(mirror, 'event');
                out.kicked += 1;
                continue;
            }
            if (!Number.isInteger(rowId)) { await fallback(mirror, 'event'); out.kicked += 1; continue; }
            if (event === 'tables.row.deleted') {
                await deleteRow(mirror, rowId);
            } else {
                await upsertRow(mirror, rowId);
            }
            out.patched += 1;
            await datatableStore.markSourceStale(mirror.id, null).catch(() => {});
        } catch (e) {
            try { await fallback(mirror, 'event'); out.kicked += 1; } catch { /* the schedule will */ }
        }
    }

    // Anything that points AT one of these mirrors now has a derived column
    // that may be wrong.
    try {
        for (const mirror of mirrors) await staleDependents(mirror);
    } catch { /* best-effort */ }
    return out;
}

async function metaOf(mirror) {
    const meta = await datatableStore.getTableMeta(mirror.scope, mirror.id);
    if (!meta) throw new Error('mirror has no columns yet');
    return { ...meta, access: synthesizeAccess(mirror) };
}

async function upsertRow(mirror, rowId) {
    const { auth } = await resolveLinker(mirror.source, { orgId: mirror.organizationId || null });
    const api = ncApi.forLinker(auth);
    const ncRow = await api.getRow(rowId);
    if (!ncRow || Number(ncRow.tableId) !== Number(mirror.source.ncTableId)) throw new Error('row is not of this table');
    const meta = await metaOf(mirror);
    const fieldsById = fieldsByIdOf(meta);
    const idx = await buildRelationIndexes(mirror.scope, mirror.source);
    const { id, values } = mirrorRowFromNc(ncRow, {
        columnMap: mirror.source.columnMap, fieldsById,
        relationIndexes: idx.relationIndexes, labelIndexes: idx.labelIndexes,
    });
    const scopeKey = datatableDbStore.scopeKey(mirror.scope);
    // Existed before? — decides whether the counter moves.
    const probe = queryCompiler.compileGetById(meta, id, ownerFilter(meta, 'read'), PG);
    const before = await datatableDbStore.query(scopeKey, scopeKey, probe.sql, probe.params);
    const existed = (before.rows || []).length > 0;
    const up = queryCompiler.compileUpsertById(meta, id, values, ownerFilter(meta, 'update'), {
        ...PG, createdBy: mirror.source.linkedByUserId || null, orgId: mirror.organizationId || null,
    });
    const res = await datatableDbStore.exec(scopeKey, scopeKey, up.sql, up.params);
    if ((res.changes || 0) > 0) await datatableStore.bumpAfterWrite(mirror.id, mirror.scope, existed ? 0 : 1);
}

async function deleteRow(mirror, rowId) {
    const meta = await metaOf(mirror);
    const scopeKey = datatableDbStore.scopeKey(mirror.scope);
    const del = queryCompiler.compileDelete(meta, String(rowId), ownerFilter(meta, 'delete'), PG);
    const res = await datatableDbStore.exec(scopeKey, scopeKey, del.sql, del.params);
    if ((res.changes || 0) > 0) await datatableStore.bumpAfterWrite(mirror.id, mirror.scope, -res.changes);
}

async function fallback(mirror, reason) {
    await datatableStore.markSourceStale(mirror.id, reason);
    const fresh = await datatableStore.getDatatable(mirror.id, mirror.scope);
    // Through the registry: a dependent (staleDependents) may be a mirror of
    // another kind, and only its own engine can refresh it.
    if (fresh) require('../index').kickStale(fresh, { reason });
}

/**
 * Mirrors in the same scope whose relations point at `mirror` — of ANY kind:
 * a spreadsheet mirror matching a column of this table is a dependent too.
 */
async function staleDependents(mirror) {
    const siblings = await datatableStore.listSourceMirrorsInScope(mirror.scope);
    for (const s of siblings) {
        if (s.id === mirror.id) continue;
        const points = ((s.source && s.source.relations) || []).some(r => r && r.targetDatatableId === mirror.id);
        if (points) await fallback(s, 'relations');
    }
}

module.exports = { onTablesEvent, EVENTS };
