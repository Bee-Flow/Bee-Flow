/**
 * Phase `table` — the one phase no model touches. `new`: create a Studio
 * datatable with the recipe's schema (the same transaction the packaging
 * installer runs — the create route's body is pinned by tests and cannot be
 * refactored into a function). `existing`: check that the chosen table can
 * carry invoices: the caller holds editor grade (the automation writes rows; a
 * mirror of a Nextcloud table or a spreadsheet writes through to its source)
 * and the required roles map
 * onto its columns.
 *
 * Every dependency is injected so the phase runs against fakes in tests; the
 * route wires the real modules.
 */

'use strict';

const { copyFor } = require('../copy');
// Core, not a feature: the one place that knows which managed kinds mirror a source.
const sources = require('../../core/dataEngine/sources');

/** The demo's language — the table is named and columned in it. */
function localeOf(playbook) {
    return (playbook && playbook.options && playbook.options.locale) || null;
}

/**
 * @param {{ playbook: object, principal: object, recipe: object, hasManageDatatables: boolean }} ctx
 * @param {object} deps  { db, datatableStore, datatableDbStore, normalizeFields, migrationPlan, ddlForTable, assertDatatableQuota, datatableAccess }
 * @returns {Promise<{ ok:true, artifacts, summary } | { ok:false, code, error, missing? }>}
 */
async function runTablePhase({ playbook, principal, recipe, hasManageDatatables = false }, deps) {
    const options = playbook.options || {};
    if (options.tableMode === 'existing') return verifyExisting({ playbook, principal, recipe }, deps);
    return createNew({ playbook, principal, recipe, hasManageDatatables }, deps);
}

/**
 * The table an earlier ATTEMPT of this playbook's table phase already created.
 *
 * The phase is not one write: the table exists before the closing save lands,
 * and when that save lost its race (or the process died mid-write) the phase
 * was failed with the id preserved in its artifacts — and the retry route
 * stashes those as `artifacts.previous`. Without this lookup a Retry created a
 * SECOND table beside the first (owner, 2026-09-17).
 */
function priorTableId(playbook) {
    const self = (Array.isArray(playbook.phases) ? playbook.phases : []).find((p) => p && (p.kind || p.key) === 'table');
    const art = (self && self.artifacts) || {};
    const prev = (art.previous && typeof art.previous === 'object') ? art.previous : {};
    return art.datatableId || prev.datatableId || null;
}

/** Load + re-verify that table; null when it is gone or no longer fits the recipe. */
async function reusePriorTable(playbook, principal, recipe, deps) {
    const id = priorTableId(playbook);
    if (!id) return null;
    const { datatableStore, datatableAccess } = deps;
    let table = null;
    let scope = null;
    for (const s of datatableAccess.datatableScopesFor(principal)) {
        table = await datatableStore.getDatatable(id, s).catch(() => null);
        if (table) { scope = s; break; }
    }
    if (!table) return null;
    const meta = await datatableStore.getTableMeta(scope, id).catch(() => null);
    const fields = (meta && Array.isArray(meta.fields) ? meta.fields : []).map((f) => ({ key: f.key, name: f.name, type: f.type }));
    const check = recipe.verifyExistingTable(fields);
    if (!check.ok) return null;
    // The registry answers "is this a mirror" — for a Nextcloud table AND a
    // spreadsheet file; a kind-string comparison here treated the second as a
    // plain table (core/dataEngine/sources/index.test.js).
    const isMirror = sources.isSourceMirror(table);
    const mirrorKind = isMirror ? sources.builderKindOf(table.managedKind) : null;
    return {
        ok: true,
        artifacts: {
            datatableId: table.id, datatableKey: table.key, datatableName: table.name,
            datatableScope: { kind: scope.kind, id: scope.id },
            fields, mapping: check.mapping, isMirror, mirrorKind, hasStatus: check.hasStatus,
            typeWarnings: check.typeWarnings, rowCount: Number(table.rowCount) || 0, reused: true,
        },
        summary: copyFor(localeOf(playbook)).tableVerified(table.name, Object.keys(check.mapping).length, { isMirror, mirrorKind, hasStatus: check.hasStatus }),
    };
}

async function createNew({ playbook, principal, recipe, hasManageDatatables }, deps) {
    const locale = localeOf(playbook);
    const copy = copyFor(locale);
    const title = String((playbook.options && playbook.options.tableTitle) || (typeof recipe.tableTitleFor === 'function' ? recipe.tableTitleFor(locale) : recipe.title));
    // Retry of a phase whose table already landed: reuse it, never a second one.
    const reused = await reusePriorTable(playbook, principal, recipe, deps);
    if (reused) return reused;
    // The one shared creator (core/dataEngine/createStudioDatatable) — the
    // automation builder's builder_create_datatable makes tables the same way.
    const { createStudioDatatable } = deps.createStudioDatatable ? { createStudioDatatable: deps.createStudioDatatable } : require('../../core/dataEngine/createStudioDatatable');
    const existing = await deps.datatableStore.listDatatablesForScope(deps.datatableAccess.defaultCreateScope(principal) || { kind: 'user', id: playbook.userId }).catch(() => []);
    const usedKeys = new Set((existing || []).map((t) => t && t.key).filter(Boolean));
    const result = await createStudioDatatable({
        ownerUserId: playbook.userId, principal, name: title,
        key: recipe.defaultTableKey(title, usedKeys, locale),
        description: copy.tableDescription(title),
        fields: (typeof recipe.schemaFor === 'function' ? recipe.schemaFor(locale) : recipe.schema).map((f) => ({ ...f })),
        hasManageDatatables,
    }, deps);
    if (!result.ok) return result;
    const { table } = result;
    const fields = table.fields.map((f) => ({ key: f.key, name: f.name, type: f.type }));
    return {
        ok: true,
        artifacts: {
            datatableId: table.id, datatableKey: table.key, datatableName: table.name,
            datatableScope: table.scope,
            fields, mapping: recipe.schemaMapping(locale), isMirror: false, hasStatus: true, rowCount: 0,
        },
        summary: copy.tableCreated(table.name, fields.length),
    };
}

async function verifyExisting({ playbook, principal, recipe }, deps) {
    const { datatableStore, datatableAccess } = deps;
    const id = playbook.options && playbook.options.datatableId;
    if (!id) return { ok: false, code: 'table_required', error: 'Pick the table the automation should fill.' };
    let table = null;
    let scope = null;
    for (const s of datatableAccess.datatableScopesFor(principal)) {
        table = await datatableStore.getDatatable(id, s);
        if (table) { scope = s; break; }
    }
    if (!table) return { ok: false, code: 'table_not_found', error: 'That table does not exist, or is not yours to use.' };
    const grants = await datatableStore.listGrants(id).catch(() => []);
    const grade = datatableAccess.gradeForPrincipal(table, grants, principal);
    if (!datatableAccess.gradeAtLeast(grade, 'editor')) {
        return { ok: false, code: 'table_read_only', error: `You can read "${table.name}" but not write to it — the automation needs to add rows.` };
    }
    const meta = await datatableStore.getTableMeta(scope, id);
    const fields = (meta && Array.isArray(meta.fields) ? meta.fields : []).map((f) => ({ key: f.key, name: f.name, type: f.type }));
    const check = recipe.verifyExistingTable(fields);
    if (!check.ok) {
        return { ok: false, code: 'table_unusable', missing: check.missing, error: `"${table.name}" lacks the columns an invoice needs: ${check.missing.join(', ')}.` };
    }
    // The registry answers "is this a mirror" — for a Nextcloud table AND a
    // spreadsheet file; a kind-string comparison here treated the second as a
    // plain table (core/dataEngine/sources/index.test.js).
    const isMirror = sources.isSourceMirror(table);
    const mirrorKind = isMirror ? sources.builderKindOf(table.managedKind) : null;
    return {
        ok: true,
        artifacts: {
            datatableId: table.id, datatableKey: table.key, datatableName: table.name,
            datatableScope: { kind: scope.kind, id: scope.id },
            fields, mapping: check.mapping, isMirror, mirrorKind, hasStatus: check.hasStatus,
            typeWarnings: check.typeWarnings, rowCount: Number(table.rowCount) || 0,
        },
        summary: copyFor(localeOf(playbook)).tableVerified(table.name, Object.keys(check.mapping).length, { isMirror, mirrorKind, hasStatus: check.hasStatus }),
    };
}

module.exports = { runTablePhase };
