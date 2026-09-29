/**
 * App Studio — the LINKED table, seen from the builder.
 *
 * A model table with `source: { kind:'datatable', datatableId, mode }` keeps
 * its rows in a Studio datatable outside the app — a Nextcloud Tables mirror
 * (a source mirror, core/dataEngine/sources) or any organisation table. The runtime
 * already reads and writes through that link (datatableSource.js); what was
 * missing is everything the BUILDER needs to talk about it:
 *
 *   • which datatable a name like "Facturen" means, and whether this app's
 *     owner may read (or write) it — resolveLinkableDatatable;
 *   • the model table that link becomes, fields projected from the datatable
 *     verbatim (keys like excl_btw are what bindings must use) —
 *     projectLinkedTable;
 *   • what to tell the model about a table that is linked: live row count,
 *     mode, where the rows live — describeLinkedTables, and the overlay that
 *     stops the per-app recount from printing `rows=0` for a table whose
 *     rows were never in the per-app database.
 *
 * Every store call is injectable (`deps`) so the pure parts test without a
 * database; every store failure degrades to "unknown", never to a throw that
 * would end a builder turn.
 */

'use strict';

const sources = require('../core/dataEngine/sources');
const { keyFromTitle } = require('../core/dataEngine/sources/mirror/keys');
const { TABLE_SOURCE_MODES, WRITABLE_TABLE_SOURCE_MODE, DATATABLE_ID_RE } = require('../core/dataEngine/dataModel/vocabulary');
const { projectFieldsForModel, isDatatableBacked } = require('./datatableSource');
const { KEY_RE, newTableId } = require('./dataModel');

function loadDeps(deps = {}) {
    return {
        datatableStore: deps.datatableStore || require('../stores/datatableStore'),
        access: deps.access || require('../auth/datatableAccess'),
    };
}

/** The principal for an app owner, or null when identity cannot be read. */
async function ownerPrincipal(ownerId, { access }) {
    if (typeof ownerId !== 'string' || !ownerId) return null;
    try {
        const p = await access.resolveDatatablePrincipalForUser(ownerId);
        if (!p || !p.userId || p.identityError) return null;
        return p;
    } catch (_) {
        return null;
    }
}

/** Every datatable the owner can address, with the scope it lives in. */
async function listOwnerDatatables(principal, { datatableStore, access }) {
    const out = [];
    for (const scope of access.datatableScopesFor(principal)) {
        let list = [];
        try { list = await datatableStore.listDatatablesForScope(scope); } catch (_) { list = []; }
        for (const dt of list || []) if (dt && typeof dt.id === 'string') out.push({ dt, scope });
    }
    return out;
}

const lc = (s) => String(s || '').trim().toLowerCase();

/**
 * Which datatable a builder call means. Match order: exact id → exact key →
 * case-blind name → the key the title would produce (keyFromTitle("Excl.
 * btw") is "excl_btw", so "Facturen Q3" finds key facturen_q3). Two or more
 * matches are never guessed; zero matches list what IS there — that list is
 * the discovery answer a model without a list tool needs.
 *
 * @returns {Promise<{ datatable, scope, principal, grade } | { error, _fixHint, candidates? }>}
 */
async function resolveLinkableDatatable({ ownerId, datatableId, key, name, mode = 'read' }, deps = {}) {
    const d = loadDeps(deps);
    if (!TABLE_SOURCE_MODES.includes(mode)) {
        return { error: `mode must be one of ${TABLE_SOURCE_MODES.join(', ')} — got ${JSON.stringify(mode)}.`, _fixHint: 'Omit mode to link read-only.' };
    }
    const ref = [datatableId, key, name].find((v) => typeof v === 'string' && v.trim());
    if (!ref) {
        return { error: 'Name the Studio table to link: its id (tbl_…), its key, or its title as shown in Studio > Datatables.', _fixHint: 'Pass name:"<title>" when you do not know the id.' };
    }
    const principal = await ownerPrincipal(ownerId, d);
    if (!principal) {
        return { error: 'The app owner\'s Studio tables could not be read right now — this is an availability problem, not your arguments.', _fixHint: 'Try once more; if it persists, tell the user.' };
    }
    const all = await listOwnerDatatables(principal, d);
    const wanted = ref.trim();
    let hits = [];
    if (typeof datatableId === 'string' && datatableId.trim()) hits = all.filter(({ dt }) => dt.id === datatableId.trim());
    if (!hits.length && typeof key === 'string' && key.trim()) hits = all.filter(({ dt }) => lc(dt.key) === lc(key));
    if (!hits.length && typeof name === 'string' && name.trim()) {
        hits = all.filter(({ dt }) => lc(dt.name) === lc(name));
        if (!hits.length) {
            const asKey = keyFromTitle(name, 0, new Set());
            hits = all.filter(({ dt }) => dt.key === asKey || lc(dt.key) === lc(name));
        }
    }
    if (!hits.length && DATATABLE_ID_RE.test(wanted)) hits = all.filter(({ dt }) => dt.id === wanted);
    const describe = ({ dt }) => `"${dt.name}" (id ${dt.id}, key ${dt.key}, ${dt.rowCount ?? 0} rows${sources.isSourceMirror(dt) ? `, ${sources.sourceLabel(dt)} mirror` : ''})`;
    if (!hits.length) {
        return {
            error: `No Studio table called ${JSON.stringify(wanted)} is visible to the app owner. Tables: ${all.length ? all.map(describe).join('; ') : '(none)'}.`,
            _fixHint: 'Use one of the names or ids listed, or tell the user the table does not exist yet.',
            candidates: all.map(({ dt }) => ({ id: dt.id, name: dt.name, key: dt.key, rowCount: dt.rowCount ?? 0 })),
        };
    }
    if (hits.length > 1) {
        return {
            error: `${JSON.stringify(wanted)} matches ${hits.length} Studio tables: ${hits.map(describe).join('; ')} — pass the id.`,
            _fixHint: 'Pass datatableId with the id of the one you mean.',
            candidates: hits.map(({ dt }) => ({ id: dt.id, name: dt.name, key: dt.key, rowCount: dt.rowCount ?? 0 })),
        };
    }
    const { dt, scope } = hits[0];
    let grants = [];
    try { grants = await d.datatableStore.listGrants(dt.id); } catch (_) { grants = []; }
    const grade = d.access.gradeForPrincipal(dt, grants, principal);
    if (!grade) {
        return { error: `The app owner has no access to the Studio table "${dt.name}" (${dt.id}).`, _fixHint: 'Ask the user to share the table with the app owner, or pick another table.' };
    }
    if (mode === WRITABLE_TABLE_SOURCE_MODE && !d.access.gradeAtLeast(grade, 'editor')) {
        return { error: `The app owner may only READ the Studio table "${dt.name}" — a readwrite link needs editor access.`, _fixHint: 'Link it read-only (omit mode), or ask for editor access.' };
    }
    return { datatable: dt, scope, principal, grade };
}

/**
 * The model table a link becomes — PURE. Field ids and keys are copied
 * verbatim (fld_nc… ids pass FIELD_ID_RE; keys are what bindings use);
 * relation fields are re-pointed or degraded by projectFieldsForModel.
 * Idempotent on an existing link: keeps id/key/access, refreshes fields,
 * changes mode only when asked.
 */
function projectLinkedTable({ model, datatable, tableMeta, mode, tableKey, access, existing = null }) {
    const projected = projectFieldsForModel(tableMeta && Array.isArray(tableMeta.fields) ? tableMeta.fields : [], model);
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    let key = existing ? existing.key : (typeof tableKey === 'string' && tableKey.trim() ? tableKey.trim() : datatable.key);
    if (!KEY_RE.test(key)) key = keyFromTitle(key, 0, new Set());
    if (!existing) {
        const used = new Set(tables.map((t) => t && t.key).filter(Boolean));
        let candidate = key;
        let n = 2;
        while (used.has(candidate)) { candidate = `${key}_${n}`; n += 1; }
        key = candidate;
    }
    const table = {
        ...(existing || {}),
        id: existing ? existing.id : newTableId(),
        key,
        name: existing ? (existing.name || datatable.name) : datatable.name,
        icon: existing ? (existing.icon ?? null) : null,
        source: { kind: 'datatable', datatableId: datatable.id, mode: mode || (existing && existing.source && existing.source.mode) || 'read' },
        fields: projected.fields,
        // Mirror rows carry created_by = the account that linked the table in
        // Studio; an 'owner' row scope would show every other viewer nothing.
        access: existing ? existing.access : (access && typeof access === 'object' && !Array.isArray(access) ? access : { default: 'app' }),
    };
    return { table, warnings: projected.warnings };
}

/**
 * What the builder tells the model about each linked table of a model —
 * keyed by MODEL table id. Never throws; a table whose datatable is gone is
 * reported `missing`, a store that cannot be read yields an empty Map (the
 * data block then prints the table like its own, exactly as before).
 */
async function describeLinkedTables(model, ownerId, deps = {}) {
    const out = new Map();
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    const linked = tables.filter((t) => isDatatableBacked(t));
    if (!linked.length) return out;
    const d = loadDeps(deps);
    const principal = await ownerPrincipal(ownerId, d);
    if (!principal) return out;
    const scopes = d.access.datatableScopesFor(principal);
    for (const t of linked) {
        let dt = null;
        for (const scope of scopes) {
            try { dt = await d.datatableStore.getDatatable(t.source.datatableId, scope); } catch (_) { dt = null; }
            if (dt) break;
        }
        const mode = TABLE_SOURCE_MODES.includes(t.source.mode) ? t.source.mode : 'read';
        if (!dt) {
            out.set(t.id, { datatableId: t.source.datatableId, mode, name: t.name || t.key, key: t.key, rowCount: null, managedKind: null, lastSyncAt: null, status: null, missing: true });
            continue;
        }
        out.set(t.id, {
            datatableId: dt.id,
            mode,
            name: dt.name,
            key: dt.key,
            rowCount: Number.isFinite(Number(dt.rowCount)) ? Number(dt.rowCount) : 0,
            managedKind: dt.managedKind || null,
            lastSyncAt: (dt.syncState && dt.syncState.lastSyncAt) || null,
            status: (dt.syncState && dt.syncState.status) || null,
            missing: false,
        });
    }
    return out;
}

/**
 * Row counts with the linked tables' LIVE counts laid over the per-app
 * recount (which counts a database those rows were never in, and so says 0).
 * Pure; returns a new object.
 */
function overlayLinkedRowCounts(rowCounts, linked) {
    const out = { ...(rowCounts && typeof rowCounts === 'object' ? rowCounts : {}) };
    if (!(linked instanceof Map)) return out;
    for (const [tableId, info] of linked) {
        if (info && !info.missing && Number.isFinite(info.rowCount)) out[tableId] = info.rowCount;
    }
    return out;
}

module.exports = {
    resolveLinkableDatatable,
    projectLinkedTable,
    describeLinkedTables,
    overlayLinkedRowCounts,
};
