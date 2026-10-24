// @typecheck
// The one place the data tools reach into the automation validator (pickClosestId): layering budget counts requires.
const { pickClosestId } = require('../../automation/validate/helpers');
const { emptyDataModel } = require('../dataModel');
const { persistDraft } = require('./persistence');
const log = require('../../telemetry/log');

/**
 * The refusal every data tool gives for a LINKED table (source: datatable).
 * Its rows live in a Studio table — a Nextcloud mirror an automation fills, an
 * org table — and are read live. Seeding it would write fictional rows into
 * the real table (readwrite) or fail per row (read); evolving its fields here
 * would drift the copy from the source; a saved dataset cannot read it yet.
 */
function linkedTableRefusal(table, what) {
    const name = table.name || table.key || table.id;
    const bind = `Bind components to ${table.id} with {kind:"records"|"record"|"aggregate", tableId:"${table.id}"} using its field keys (${(table.fields || []).map((f) => f.key).join(', ')}).`;
    switch (what) {
        case 'seed':
            return {
                error: `"${name}" is a LINKED table — its rows live in the Studio table (${table.source.datatableId}) and are read live, so there is nothing to seed here.`,
                _fixHint: `${bind} If the table really is empty, rows are added in Nextcloud or Studio > Datatables, not by this app.`,
            };
        case 'fields':
            return {
                error: `"${name}" is a LINKED table — its columns come from the Studio table and cannot be changed here.`,
                _fixHint: 'Call app_link_datatable again for this table to refresh its field copy; only name, icon and access can change through app_upsert_table.',
            };
        case 'dataset':
            return {
                error: `Saved datasets cannot read the LINKED table "${name}" yet.`,
                _fixHint: `Use an inline {kind:"aggregate", tableId:"${table.id}", aggregates:[…], groupBy?:[…], pick?:{…}} binding on the component instead.`,
            };
        default:
            return { error: `"${name}" is a LINKED table.`, _fixHint: bind };
    }
}

const DATA_CONFLICT_ERROR = 'The data model changed in another tab (version conflict) — the draft state now shows the latest tables; retry the operation against them.';

/** The draft's data model as a mutable copy (empty model when none yet). */
function currentDataModel(draftWrap) {
    return (draftWrap.dataModel && typeof draftWrap.dataModel === 'object')
        ? structuredClone(draftWrap.dataModel)
        : emptyDataModel();
}

/**
 * Normalize a row-counts map onto TABLE IDS (the draftWrap/rendering
 * convention). The store keys row_counts by table KEY; tolerate either.
 */
function rowCountsById(model, counts) {
    const out = {};
    const c = (counts && typeof counts === 'object') ? counts : {};
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    for (const t of tables) {
        if (!t || typeof t.id !== 'string') continue;
        const n = c[t.id] !== undefined ? c[t.id] : c[t.key];
        if (n !== undefined) out[t.id] = Math.max(0, parseInt(n, 10) || 0);
    }
    return out;
}

/** Find a model table by tbl_… id (preferred) or physical key. */
function findModelTable(model, ref) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    return tables.find((t) => t && (t.id === ref || t.key === ref)) || null;
}

function tableIdHint(model) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    return tables.length
        ? `Known tables: ${tables.map((t) => `${t.id} (${t.key})`).join(', ')}.`
        : 'The app has no data tables yet — create one with app_upsert_table first.';
}

/**
 * Write `nextModel` through studioAppDataStore.saveDataModel (CAS). Mirrors
 * persistDraft: creates the studio_apps row first when the draft has no appId
 * yet; on a version conflict re-applies the caller's PURE op onto the server's
 * model (`rebase(serverModel)` → next model or { error }) and retries ONCE.
 * On success adopts model/version/rowCounts onto the draftWrap. Returns:
 *   { ok:true, version, model }   — adopted
 *   { invalid:true, errors }      — validateDataModel rejected (self-repair)
 *   { error }                     — persistent conflict / not found / store failure
 */
async function persistDataModel(draftWrap, nextModel, { rebase = null } = {}) {
    if (!draftWrap.appId) {
        const created = await persistDraft(draftWrap);
        if (created.error) return created;
    }
    const studioAppDataStore = require('../../stores/studioAppDataStore');
    try {
        let model = nextModel;
        let res = await studioAppDataStore.saveDataModel(draftWrap.appId, draftWrap.userId, model, {
            expectedVersion: draftWrap.dataModelVersion ?? null,
        });
        if (res.conflict && typeof rebase === 'function') {
            const rebased = rebase(res.model || emptyDataModel());
            if (rebased && rebased.error) return rebased;
            model = rebased;
            res = await studioAppDataStore.saveDataModel(draftWrap.appId, draftWrap.userId, model, {
                expectedVersion: res.currentVersion,
            });
        }
        if (res.invalid) return { invalid: true, errors: res.errors };
        if (res.conflict) return { error: DATA_CONFLICT_ERROR };
        if (res.notFound) return { error: 'This app no longer exists — it may have been deleted in another tab. Start a new app.' };
        if (!res.ok) return { error: 'Could not save the data model.' };
        draftWrap.dataModel = model;
        draftWrap.dataModelVersion = res.version;
        // saveDataModel recounted rows authoritatively — refresh, best-effort.
        // The recount is of the per-app database; a LINKED table's rows were
        // never in it, so its live count is laid back over the result (the
        // route described the linked tables at the start of the turn).
        try {
            const counts = await studioAppDataStore.getRowCounts(draftWrap.appId, draftWrap.userId);
            const { overlayLinkedRowCounts } = require('../linkedTables');
            draftWrap.rowCounts = overlayLinkedRowCounts(rowCountsById(model, counts), draftWrap.linkedTables);
        } catch (err) { log.debug('stale counts are advisory', err); }
        return { ok: true, version: res.version, model };
    } catch (e) {
        return { error: `Could not save the data model: ${e.message}` };
    }
}

/** Map persistDataModel's non-ok results to a tool result (or null when ok). */
function dataModelPersistError(persisted) {
    if (persisted.error) return persisted;
    if (persisted.invalid) {
        return {
            error: 'The data model failed validation — fix every error below, then call the tool again.',
            errors: persisted.errors,
            _fixHint: 'Table/field keys are lowercase snake_case; select fields need options; relations must point at existing tbl_… ids.',
        };
    }
    return null;
}

module.exports = { pickClosestId, linkedTableRefusal, currentDataModel, rowCountsById, findModelTable, tableIdHint, persistDataModel, dataModelPersistError };
