// @typecheck
// The one place the data tools reach into the automation validator (pickClosestId): layering budget counts requires.
const { pickClosestId } = require('../../utils/closestId.mts');
const { emptyDataModel } = require('../dataModel');
const { persistDraft } = require('./persistence');
const { fallback } = require('../../utils/bestEffort');
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
 *   { ok:true, version, model, report }  — adopted (report: the migration report)
 *   { invalid:true, errors }      — validateDataModel rejected (self-repair)
 *   { conversionRefused:true, conversions } / { migrationFailed:true, failure }
 *                                 — the save's own refusals (dataModelPersistError words them)
 *   { error }                     — persistent conflict / not found / store failure
 * `saveOpts` go to saveDataModel as they are (convertTypes, onUnconvertible).
 */
async function persistDataModel(draftWrap, nextModel, /** @type {{ rebase?: ((serverModel: Record<string, unknown>) => Record<string, unknown> | null) | null, saveOpts?: Record<string, unknown> }} */ { rebase = null, saveOpts = {} } = {}) {
    if (!draftWrap.appId) {
        const created = await persistDraft(draftWrap);
        if (created.error) return created;
    }
    const studioAppDataStore = require('../../stores/studioAppDataStore');
    try {
        let model = nextModel;
        let res = await studioAppDataStore.saveDataModel(draftWrap.appId, draftWrap.userId, model, {
            ...saveOpts,
            expectedVersion: draftWrap.dataModelVersion ?? null,
        });
        if (res.conflict && typeof rebase === 'function') {
            const rebased = rebase(res.model || emptyDataModel());
            if (rebased && rebased.error) return rebased;
            model = rebased;
            res = await studioAppDataStore.saveDataModel(draftWrap.appId, draftWrap.userId, model, {
                ...saveOpts,
                expectedVersion: res.currentVersion,
            });
        }
        if (res.invalid) return { invalid: true, errors: res.errors };
        if (res.conversionRefused) return { conversionRefused: true, conversions: res.conversions || [] };
        if (res.migrationFailed) return { migrationFailed: true, failure: res.failure };
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
        } catch (err) { fallback('appStudio/builderTools/dataToolsShared:persistDataModel', err); /* stale counts are advisory */ }
        return { ok: true, version: res.version, model, report: res.report || null };
    } catch (e) {
        // A refusal the store words for the caller (409 managed part, 422 …) is passed on.
        const status = /** @type {{ status?: unknown }} */ (e).status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
            return { error: `Could not save the data model: ${/** @type {Error} */ (e).message}` };
        }
        // Never the database's own text: it can quote a row value.
        log.warn(`[StudioBuilder] data model save failed for ${draftWrap.appId}: ${/** @type {{ code?: unknown }} */ (e).code || 'no code'}`);
        return { error: 'Could not save the data model (the database refused the change). Nothing was saved.' };
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
    if (persisted.conversionRefused) {
        const bad = (persisted.conversions || []).filter((c) => c.unconvertible);
        return {
            error: `Nothing was saved: ${bad.map((c) => `${c.unconvertible} value(s) in ${c.table}.${c.field} cannot convert from ${c.from} to ${c.to}`).join('; ') || 'some values cannot convert'}.`,
            conversions: persisted.conversions,
            _fixHint: 'Fix those rows first (app_update_records), or call again with onUnconvertible:"clear" to empty them. dryRun:true lists examples.',
        };
    }
    if (persisted.migrationFailed) {
        const f = persisted.failure || {};
        return {
            error: `Nothing was saved: ${f.table}.${f.field} could not be ${f.kind === 'convert' ? 'converted' : 'recomputed'}. ${f.message || ''}`.trim(),
            failure: f,
            _fixHint: f.kind === 'recompute'
                ? 'Change the computed expr so it holds for every row (guard divisions with NULLIF, name only existing columns), then call again.'
                : 'Fix the rows that hold the value, or add a new field instead of converting this one.',
        };
    }
    return null;
}

module.exports = { pickClosestId, linkedTableRefusal, currentDataModel, rowCountsById, findModelTable, tableIdHint, persistDataModel, dataModelPersistError };
