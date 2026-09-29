/**
 * App Studio builder tools — LINKING an existing Studio table into the app.
 *
 * app_link_datatable is how the model puts a table that already exists — a
 * Nextcloud Tables mirror the owner linked in Studio > Datatables, or any
 * organisation table — into the app's data model: as a table whose rows stay
 * where they are and are read live. Before this the only way in was a
 * hand-written PUT /schema; the model could neither name such a table nor
 * see that one was linked, so a small model briefed with "the table Facturen"
 * had nowhere to go but app_upsert_table and app_seed_records — fictional
 * invoices, into the real table.
 *
 * Resolution (name/key/id → one datatable, the owner's grade) is
 * appStudio/linkedTables.js; the projection to a model table is pure and
 * shared with the human path; the save goes through persistDataModel's CAS
 * like every other data tool.
 */

'use strict';

const { resolveLinkableDatatable, projectLinkedTable, describeLinkedTables, overlayLinkedRowCounts } = require('../linkedTables');
const { canonicalizeDataModel, validateDataModel, emptyDataModel } = require('../dataModel');
const { persistDataModel, dataModelPersistError } = require('./dataTools');

function currentModel(draftWrap) {
    return (draftWrap.dataModel && typeof draftWrap.dataModel === 'object')
        ? structuredClone(draftWrap.dataModel)
        : emptyDataModel();
}

/** The linked model table for a datatable id, if this app already has one. */
function existingLinkFor(model, datatableId) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    return tables.find((t) => t && t.source && t.source.kind === 'datatable' && t.source.datatableId === datatableId) || null;
}

/**
 * app_link_datatable — { name?, key?, datatableId?, mode?, tableKey?, access? }.
 * Idempotent: a second call for the same datatable refreshes the field copy
 * and (only when passed) the mode — never a second table. Small models resend
 * calls; this must be safe to repeat.
 */
/** The app-local table a reference names (its tbl_ id or key), when it is a link. */
function appLocalLink(model, ref) {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    const wanted = ref.trim().toLowerCase();
    return tables.find((t) => t && t.source && t.source.kind === 'datatable' && (String(t.id).toLowerCase() === wanted || String(t.key || '').toLowerCase() === wanted)) || null;
}

async function applyLinkDatatable(draftWrap, args, deps = {}) {
    const a = args && typeof args === 'object' ? args : {};
    const modePassed = a.mode !== undefined && a.mode !== null && a.mode !== '';
    const mode = modePassed ? a.mode : 'read';
    // The model reads the APP's tbl_ id off the draft state and links "it"
    // again (measured 2026-09-14 on every second turn): that id names the
    // link that already exists — answer for the Studio table behind it.
    const local = appLocalLink(currentModel(draftWrap), a.datatableId) || appLocalLink(currentModel(draftWrap), a.name) || appLocalLink(currentModel(draftWrap), a.key);
    if (local) {
        a.datatableId = local.source.datatableId;
        delete a.name; delete a.key;
        a._relinkNote = `"${local.id}" is this app's own table for Studio table ${local.source.datatableId} — read as that link${modePassed ? ` (mode ${mode})` : ''}.`;
    }
    const resolved = await resolveLinkableDatatable({
        ownerId: draftWrap.userId,
        datatableId: a.datatableId,
        key: a.key,
        name: a.name,
        mode,
    }, deps);
    if (resolved.error) return resolved;
    const { datatable, scope } = resolved;

    const datatableStore = deps.datatableStore || require('../../stores/datatableStore');
    let tableMeta = null;
    try { tableMeta = await datatableStore.getTableMeta(scope, datatable.id); } catch (_) { tableMeta = null; }
    if (!tableMeta) {
        return { error: `The Studio table "${datatable.name}" has no readable schema right now.`, _fixHint: 'Try once more; if it persists, tell the user.' };
    }

    // PURE op applied to the current model — and re-applied on a CAS conflict.
    const op = (model) => {
        const existing = existingLinkFor(model, datatable.id);
        const { table, warnings } = projectLinkedTable({
            model, datatable, tableMeta,
            mode: existing && !modePassed ? existing.source.mode : mode,
            tableKey: a.tableKey, access: a.access, existing,
        });
        const tables = Array.isArray(model.tables) ? model.tables : [];
        const nextTables = existing ? tables.map((t) => (t.id === existing.id ? table : t)) : [...tables, table];
        return { model: { ...model, tables: nextTables }, table, warnings, existing: !!existing };
    };
    const base = currentModel(draftWrap);
    const merged = op(base);
    const { model: canonical } = canonicalizeDataModel(merged.model);
    const check = validateDataModel(canonical);
    if (check.errors.length) {
        return {
            error: 'Linking this table would leave the data model invalid — the errors are below.',
            errors: check.errors,
            _fixHint: 'Pass a different tableKey if the key collides; otherwise tell the user what the errors say.',
        };
    }
    const persisted = await persistDataModel(draftWrap, canonical, {
        rebase: (serverModel) => canonicalizeDataModel(op(serverModel).model).model,
    });
    const failure = dataModelPersistError(persisted);
    if (failure) return failure;

    // The live description (row count, sync state) rides on the draftWrap so
    // the data block and the data_model event read it this same turn.
    try {
        draftWrap.linkedTables = await describeLinkedTables(draftWrap.dataModel, draftWrap.userId, deps);
        draftWrap.rowCounts = overlayLinkedRowCounts(draftWrap.rowCounts, draftWrap.linkedTables);
    } catch (_) { /* advisory */ }
    const saved = (draftWrap.dataModel.tables || []).find((t) => t.source && t.source.datatableId === datatable.id) || merged.table;
    const info = draftWrap.linkedTables instanceof Map ? draftWrap.linkedTables.get(saved.id) : null;
    const kind = require('../../core/dataEngine/sources').builderKindOf(datatable.managedKind);
    return {
        table: {
            id: saved.id,
            key: saved.key,
            name: saved.name,
            fields: (saved.fields || []).map((f) => ({ key: f.key, type: f.type })),
            linked: { kind, mode: saved.source.mode, rowCount: info ? info.rowCount : (datatable.rowCount ?? 0) },
        },
        ...(merged.existing ? { note: 'already linked — fields refreshed' } : {}),
        ...(merged.warnings.length || a._relinkNote ? { _hints: [...(a._relinkNote ? [a._relinkNote] : []), ...merged.warnings] } : {}),
        _next: `Bind components to ${saved.id} with {kind:"records", tableId:"${saved.id}"} / {kind:"aggregate", tableId:"${saved.id}", …} using these field keys exactly: ${(saved.fields || []).map((f) => f.key).join(', ')}. Rows are live${saved.source.mode === 'read' ? ' and read-only' : ''} — never seed this table.`,
    };
}

module.exports = { applyLinkDatatable, existingLinkFor };
