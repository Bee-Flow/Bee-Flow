// @typecheck
/**
 * App Studio builder tools — the DATA side: tables, roles, seed rows,
 * datasets, and the read/query tools over them. See the section comment
 * below for the draftWrap fields these mutate.
 */

'use strict';

const { MAX_SEED_RECORDS } = require('./schemas');
const { AGG_FNS } = require('../dataModel');
const { parseQueryArgs, shapeTableRow, pageDatasetRows, pageMeta, queryFailure, MAX_QUERY_LIMIT } = require('./queryDataArgs');
const { persistDraft } = require('./persistence');
const { isDatatableBacked } = require('../datatableSource');
const log = require('../../telemetry/log');
const { linkedTableRefusal, rowCountsById, findModelTable, tableIdHint, persistDataModel, dataModelPersistError } = require('./dataToolsShared');
const { mergeTableOp, applyUpsertTable, findTableRefs, applyRemoveTable, applySetRoles } = require('./dataToolsTables');

// ── Data engine (per-app database) ──────────────────────────────────
//
// These tools mutate the SECOND draft the route hangs on the draftWrap: the
// data model (draftWrap.dataModel / .dataModelVersion / .rowCounts /
// .datasetIds). Model writes go through persistDataModel (the saveDataModel
// CAS seam, rebase-once on conflict); row writes go through
// actionExecutor.writeRecord — THE record-write choke point (RLS + quotas).

async function applySeedRecords(draftWrap, args) {
    const records = Array.isArray(args?.records) ? args.records : null;
    if (!records || !records.length) return { error: 'records must be a non-empty array of row objects (1–25).' };
    if (records.length > MAX_SEED_RECORDS) {
        return { error: `records: max ${MAX_SEED_RECORDS} rows per call — split the seeding into more calls.` };
    }
    const model = draftWrap.dataModel;
    const table = findModelTable(model, args?.tableId);
    if (!table) {
        return {
            error: `Unknown tableId ${JSON.stringify(args?.tableId)}.`,
            _fixHint: `${tableIdHint(model)} Use the tbl_… id from app_upsert_table's result or the draft state's data block.`,
        };
    }
    // THE guard that protects the real table: on a readwrite link these rows
    // would land in Nextcloud; on a read link every row fails with a 403.
    if (isDatatableBacked(table)) return linkedTableRefusal(table, 'seed');
    if (!draftWrap.appId) {
        const created = await persistDraft(draftWrap);
        if (created.error) return created;
    }
    const studioAppStore = require('../../stores/studioAppStore');
    let app = null;
    try { app = await studioAppStore.getStudioApp(draftWrap.appId); } catch (e) {
        return { error: `Could not load the app: ${e.message}` };
    }
    if (!app) return { error: 'This app no longer exists — it may have been deleted in another tab.' };

    const { writeRecord } = require('../actionExecutor');
    const viewer = { id: draftWrap.userId, role: 'owner' };
    const ids = [];
    const failed = [];
    for (const [i, rec] of records.entries()) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            failed.push({ index: i, error: 'each record must be an object of { fieldKey: value }' });
            continue;
        }
        try {
            const { id } = await writeRecord(app, model, table, rec, { viewer });
            ids.push(id);
        } catch (e) {
            failed.push({ index: i, error: e.message, ...(e.code ? { code: e.code } : {}) });
            if (e.code === 'quota_exceeded') {
                // Every remaining row would hit the same wall — stop here.
                if (i < records.length - 1) failed.push({ index: i + 1, error: `rows ${i + 1}–${records.length - 1} skipped after the quota error` });
                break;
            }
        }
    }
    if (ids.length) {
        const counts = { ...(draftWrap.rowCounts || {}) };
        counts[table.id] = Math.max(0, parseInt(counts[table.id], 10) || 0) + ids.length;
        draftWrap.rowCounts = counts;
    }
    if (!ids.length) {
        return {
            error: `All ${records.length} row(s) failed to insert.`,
            failed,
            _fixHint: `Field keys must exist on "${table.key}" (${(table.fields || []).map((f) => f.key).join(', ')}); system columns are filled automatically. Fix the rows and resend.`,
        };
    }
    const result = {
        inserted: ids.length,
        ids,
        tableId: table.id,
        rowCount: draftWrap.rowCounts[table.id],
    };
    if (failed.length) {
        result.failed = failed;
        result._hints = [`${failed.length} row(s) failed — fix and resend ONLY those rows (max ${MAX_SEED_RECORDS}/call).`];
    }
    return result;
}

async function applyUpsertDataset(draftWrap, args) {
    const model = draftWrap.dataModel;
    const table = findModelTable(model, args?.tableId);
    if (!table) {
        return { error: `Unknown tableId ${JSON.stringify(args?.tableId)}.`, _fixHint: `${tableIdHint(model)} Datasets aggregate ONE existing table.` };
    }
    if (isDatatableBacked(table)) return linkedTableRefusal(table, 'dataset');
    const descriptor = args?.descriptor;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        return { error: 'descriptor must be an object { groupBy?, aggregates, filters? }.' };
    }
    if (!Array.isArray(descriptor.aggregates) || !descriptor.aggregates.length) {
        return { error: 'descriptor.aggregates must be a non-empty array of { fn, field?, as }.', _fixHint: `Aggregate fns: ${AGG_FNS.join(', ')}; count needs no field.` };
    }
    if (!draftWrap.appId) {
        const created = await persistDraft(draftWrap);
        if (created.error) return created;
    }
    const studioAppDataStore = require('../../stores/studioAppDataStore');
    const studioAppStore = require('../../stores/studioAppStore');
    const datasetCache = require('../datasetCache');

    const name = (typeof args?.name === 'string' && args.name.trim()) ? args.name.trim() : null;
    const ttl = Number.isFinite(args?.cacheTtlSeconds) ? args.cacheTtlSeconds : undefined;
    let row = null;
    let created = false;
    try {
        if (args?.datasetId) {
            row = await studioAppDataStore.updateDataset(args.datasetId, draftWrap.appId, draftWrap.userId, {
                ...(name ? { name } : {}),
                tableId: table.id,
                descriptor,
                ...(ttl !== undefined ? { cacheTtlSeconds: ttl } : {}),
            });
            if (!row) {
                const known = (draftWrap.datasetIds || []).map((d) => (d && d.id) || d).filter(Boolean);
                return { error: `Unknown datasetId ${JSON.stringify(args.datasetId)}.`, _fixHint: `Known datasets: ${known.join(', ') || '(none)'} — omit datasetId to create a new one.` };
            }
        } else {
            if (!name) return { error: 'name is required when creating a dataset.' };
            row = await studioAppDataStore.createDataset(draftWrap.appId, draftWrap.userId, {
                name, tableId: table.id, descriptor,
                ...(ttl !== undefined ? { cacheTtlSeconds: ttl } : {}),
            });
            created = true;
        }
    } catch (e) {
        return { error: `Could not save the dataset: ${e.message}` };
    }

    let app = null;
    try { app = await studioAppStore.getStudioApp(draftWrap.appId); } catch (_) { app = null; }
    if (!app) return { error: 'This app no longer exists — it may have been deleted in another tab.' };

    // Implicit dry-run: execute once as the owner so the preview grounds the
    // model (and a bad descriptor surfaces NOW, not at render time).
    try {
        const out = await datasetCache.runDataset(app, model, row, { id: draftWrap.userId, role: 'owner' }, { refresh: true });
        const rows = Array.isArray(out.rows) ? out.rows : [];
        const list = Array.isArray(draftWrap.datasetIds) ? [...draftWrap.datasetIds] : [];
        const entry = { id: row.id, name: row.name };
        const idx = list.findIndex((d) => ((d && d.id) || d) === row.id);
        if (idx >= 0) list[idx] = entry; else list.push(entry);
        draftWrap.datasetIds = list;
        return {
            datasetId: row.id,
            name: row.name,
            tableId: table.id,
            preview: rows.slice(0, 10),
            rowCount: rows.length,
            ...(out.truncated ? { truncated: true } : {}),
        };
    } catch (e) {
        if (created) {
            try { await studioAppDataStore.deleteDataset(row.id, draftWrap.appId, draftWrap.userId); } catch (err) { bestEffort('appStudio/builderTools/dataTools:applyUpsertDataset', err); /* best-effort */ }
        }
        return {
            error: `The dataset descriptor did not compile: ${e.message}`,
            _fixHint: `groupBy/aggregate/filter fields must be field keys on "${table.key}" (${(table.fields || []).map((f) => f.key).join(', ')}); fns: ${AGG_FNS.join(', ')}.${created ? ' The dataset was NOT saved — fix the descriptor and call again.' : ' The dataset kept the new descriptor — fix it with another app_upsert_dataset call.'}`,
        };
    }
}

function applyGetDataModel(draftWrap) {
    const { renderDataBlock } = require('../builderPrompt');
    return {
        data: renderDataBlock(draftWrap.dataModel ?? null, draftWrap.datasetIds, draftWrap.rowCounts, draftWrap.linkedTables || null, { fieldIds: true }),
        modelVersion: draftWrap.dataModelVersion ?? 0,
    };
}

// app_list_connectors — the SAFE projection of the app's owner-authored external
// connectors (never fixedArgs / url / credentials). Read-only. The AI WIRES
// existing connectors into {kind:'connector'} bindings; it never authors them.
function applyListConnectors(draftWrap) {
    const connectors = require('../connectors');
    const list = connectors.listConnectors(draftWrap.dataModel ?? null);
    return {
        connectors: list,
        note: list.length
            ? "Bind one into a component's data prop with { kind:\"connector\", connectorId, params? }. You wire existing connectors — the owner authors credentials in the Connectors tab."
            : 'No connectors yet — the app owner adds them in the Connectors tab; you cannot create them.',
    };
}

async function applyQueryData(draftWrap, args) {
    const model = draftWrap.dataModel;
    if (!draftWrap.appId || !model || !Array.isArray(model.tables) || !model.tables.length) {
        return { error: 'The app has no data tables yet — create one with app_upsert_table and seed it first.' };
    }
    const parsed = parseQueryArgs(args);
    if (parsed.error) return { ...parsed, ...(parsed._fixHint ? {} : { _fixHint: tableIdHint(model) }) };
    const { tableId, datasetId, limit, filter, sort, cursor } = parsed;
    const studioAppStore = require('../../stores/studioAppStore');
    let app = null;
    try { app = await studioAppStore.getStudioApp(draftWrap.appId); } catch (_) { app = null; }
    if (!app) return { error: 'This app no longer exists — it may have been deleted in another tab.' };

    let linked = false;
    try {
        if (datasetId) {
            if (filter || sort) {
                return { error: 'filter and sort apply to raw table rows (tableId); a saved dataset returns its own aggregation.', _fixHint: 'Page through a dataset with cursor, or query its source table with tableId.' };
            }
            const studioAppDataStore = require('../../stores/studioAppDataStore');
            const ds = await studioAppDataStore.getDataset(datasetId, draftWrap.appId, draftWrap.userId);
            if (!ds) {
                const known = (draftWrap.datasetIds || []).map((d) => (d && d.id) || d).filter(Boolean);
                return { error: `Unknown datasetId ${JSON.stringify(datasetId)}.`, _fixHint: `Known datasets: ${known.join(', ') || '(none)'}.` };
            }
            const datasetCache = require('../datasetCache');
            const out = await datasetCache.runDataset(app, model, ds, { id: draftWrap.userId, role: 'owner' });
            const page = pageDatasetRows(Array.isArray(out.rows) ? out.rows : [], cursor, limit);
            return { ...page, ...pageMeta({}, parsed) };
        }
        const table = findModelTable(model, tableId);
        if (!table) {
            return { error: `Unknown tableId ${JSON.stringify(tableId)}.`, _fixHint: tableIdHint(model) };
        }
        // One read path for both kinds of table: the app runtime's own runner
        // (access filter, owner-scoped handle, keyset cursor). A linked table's
        // rows live in a Studio table, read grade-checked and stale-while-serve.
        linked = isDatatableBacked(table);
        const dataReadRunner = require('../dataReadRunner');
        const ctx = {
            app,
            ownerScope: app.userId,
            viewerId: draftWrap.userId,
            role: 'owner',
            viewer: { id: draftWrap.userId, role: 'owner' },
            model,
        };
        const out = await dataReadRunner.runRecordList(ctx, table, { filters: filter, sort, cursor, limit });
        const rows = (Array.isArray(out.records) ? out.records : []).map((r) => shapeTableRow(r, table));
        return {
            rows,
            rowCount: rows.length,
            ...pageMeta({ more: !!out.nextCursor, nextCursor: out.nextCursor }, parsed),
            ...(linked ? { linked: true } : {}),
        };
    } catch (e) {
        return queryFailure(e, { appId: draftWrap.appId, linked });
    }
}

const { applyListDocuments } = require('./documentListTool');
const { bestEffort } = require('../../utils/bestEffort');

module.exports = {
    applyListDocuments,
    persistDataModel,
    dataModelPersistError,
    applyUpsertTable,
    applyRemoveTable,
    applySetRoles,
    applySeedRecords,
    applyUpsertDataset,
    applyGetDataModel,
    applyListConnectors,
    applyQueryData,
    // internals re-exported through ../builderTools.js _test (rowCountsById is
    // also the template installer's counts normalizer)
    mergeTableOp,
    findTableRefs,
    rowCountsById,
    linkedTableRefusal,
    MAX_QUERY_LIMIT,
};
