/**
 * Tables the builder PROPOSES but has not created yet.
 *
 * In a preview (Approve each change, or a change that waits for Apply) the
 * assistant must not make a real table: a table is an object outside the
 * draft, and the user may discard the proposal. Instead builder_create_datatable
 * STAGES it: the table gets an id of the form "pending:<n>", steps are bound
 * to that id like to a real one, and the proposal carries the table (name +
 * columns). Only the user's Apply creates it (routes/ai/automationBuilder/
 * applyPendingDatatables.js) and swaps every "pending:<n>" for the real id.
 *
 * This module is pure (no db, no state); the staging function takes its
 * collaborators as `deps` so it is testable. Layering: the deep walk lives
 * here and datatableApproval.js imports it; the approval module is required
 * lazily from staging, never at load, so the two cannot form a cycle.
 *
 * The id grammar (PENDING_DATATABLE_RE) is shared with the validator and the
 * runner through validate/constants.js. Client twin:
 * agent-hub/src/components/automation/Builder/chat/pendingTables.ts.
 */

'use strict';

const { PENDING_DATATABLE_RE } = require('../validate/constants');

const MAX_PENDING_TABLES = 5;
const MAX_WALK_DEPTH = 60;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const isPendingDatatableId = (id) => typeof id === 'string' && PENDING_DATATABLE_RE.test(id);

/** n = 1 + the highest n in the list, so a ref is never reused within a proposal. */
function nextPendingRef(list) {
    let max = 0;
    for (const e of Array.isArray(list) ? list : []) {
        const m = e && typeof e.ref === 'string' && /^pending:(\d+)$/.exec(e.ref);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `pending:${max + 1}`;
}

/** The catalog row a pending table shows as: the same shape as a real one, flagged `pending`. */
function pendingCatalogEntry(e) {
    return {
        id: e.ref, key: e.key, name: e.name, description: e.description || '', rowCount: 0,
        canWrite: true, managedKind: null, scope: e.scope || 'org', pending: true,
        columns: (e.fields || []).map((f) => ({ key: f.key, name: f.name, type: f.type, unique: false })),
    };
}

/**
 * Visit every object that has a string `datatableId`, anywhere in a
 * definition: root, triggers, steps, loop bodies, branch containers, layers
 * and http_request.cacheInto. A deep walk (not a list of known places) so a
 * container added next year is covered too. `visit(obj, scope)` gets the name
 * of the layer the object sits in (null for the root graph).
 */
function walkDatatableRefs(def, visit) {
    const seen = new WeakSet();
    const walk = (node, scope, depth) => {
        if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const x of node) walk(x, scope, depth + 1); return; }
        if (typeof node.datatableId === 'string') visit(node, scope);
        for (const [k, v] of Object.entries(node)) {
            if (!v || typeof v !== 'object') continue;
            if (k === 'layers' && isObj(v) && depth <= 1) {
                for (const [name, g] of Object.entries(v)) walk(g, name, depth + 2);
            } else walk(v, scope, depth + 1);
        }
    };
    walk(def, null, 0);
}

/** Every "pending:<n>" the definition points at. */
function collectPendingRefs(def) {
    const out = new Set();
    walkDatatableRefs(def, (o) => { if (isPendingDatatableId(o.datatableId)) out.add(o.datatableId); });
    return out;
}

/** The REAL table ids the definition points at (what the flow already uses). */
function boundDatatableIds(def) {
    const out = new Set();
    walkDatatableRefs(def, (o) => { if (o.datatableId && !isPendingDatatableId(o.datatableId)) out.add(o.datatableId); });
    return out;
}

/**
 * Swap every pending ref for the real table. `map` is ref → {id, key}. Returns
 * a new definition (the input is never mutated) and the refs that were not in
 * the map. A step gets the real `datatableKey` beside the id; a bare reference
 * (http_request.cacheInto) has no key field and gets the id only.
 */
function rebindPendingDatatables(def, map) {
    const unknownRefs = new Set();
    const lookup = map instanceof Map ? map : new Map(Object.entries(map || {}));
    const clone = structuredClone(def);
    walkDatatableRefs(clone, (o) => {
        if (!isPendingDatatableId(o.datatableId)) return;
        const hit = lookup.get(o.datatableId);
        if (!hit || !hit.id) { unknownRefs.add(o.datatableId); return; }
        o.datatableId = hit.id;
        if (hit.key && (typeof o.type === 'string' || 'datatableKey' in o)) o.datatableKey = hit.key;
    });
    return { definition: clone, unknownRefs: [...unknownRefs] };
}

function stepsByScope(def) {
    const map = new Map();
    walkDatatableRefs(def, (o, scope) => { if (typeof o.id === 'string') map.set(`${scope || ''}\u0000${o.id}`, o); });
    return map;
}

/**
 * The tables the proposal's added or changed datatable steps use, for the
 * review card: `newlyBound` = the flow did not reference that table before.
 */
function usedDatatables(baseDef, def, catalog, pending = []) {
    const byId = new Map();
    for (const t of Array.isArray(catalog) ? catalog : []) if (t && t.id) byId.set(t.id, t);
    for (const e of Array.isArray(pending) ? pending : []) if (e && e.ref && !byId.has(e.ref)) byId.set(e.ref, pendingCatalogEntry(e));
    const before = stepsByScope(baseDef);
    const already = boundDatatableIds(baseDef);
    const out = new Map();
    walkDatatableRefs(def, (o, scope) => {
        if (o.type !== 'datatable' || !o.datatableId) return;
        const old = before.get(`${scope || ''}\u0000${o.id}`);
        if (old && JSON.stringify(old) === JSON.stringify(o)) return;
        const row = byId.get(o.datatableId);
        const cur = out.get(o.datatableId) || {
            id: o.datatableId,
            key: row?.key || o.datatableKey || null,
            name: row?.name || o.datatableKey || o.datatableId,
            pending: isPendingDatatableId(o.datatableId),
            newlyBound: !already.has(o.datatableId),
            stepIds: [],
        };
        if (typeof o.id === 'string' && !cur.stepIds.includes(o.id)) cur.stepIds.push(o.id);
        out.set(o.datatableId, cur);
    });
    return [...out.values()];
}

/**
 * The validator always flags a pending id (datatable.table_pending); a table
 * this proposal STAGED is legitimately pending, so its flags are dropped here.
 * Any other pending ref stays an error.
 */
function withoutStagedTableIssues(validation, refs) {
    if (!validation || typeof validation !== 'object') return validation;
    const staged = refs instanceof Set ? refs : new Set(refs || []);
    const errors = (validation.errors || []).filter((e) => !(e && e.code === 'datatable.table_pending' && staged.has(e.ref)));
    return { ...validation, errors, ok: errors.length === 0 };
}

const strip = (s) => String(s || '').trim();

/**
 * builder_create_datatable in a preview: record the table in the proposal and
 * answer as if it existed, with a pending id. See the module header.
 *
 * @param {object} draftWrap  uses _datatables (catalog; null = unreadable), _pendingDatatables,
 *        _datatableCreate (access check made at turn start), _approvedDatatableIds
 * @param {object} args       { name, fields, description?, key? }
 * @param {object} deps       { normaliseFieldArgs, normalizeFields, keyFromTitle, normaliseKey }
 */
function stagePendingDatatable(draftWrap, args, deps) {
    const { normaliseFieldArgs, normalizeFields, keyFromTitle, normaliseKey } = deps;
    const a = isObj(args) ? args : {};
    const name = strip(a.name || a.title).slice(0, 120);
    const notes = [];
    if (!name) return { error: 'name is required — the table\'s title as the person will see it in Studio > Datatables.', _fixHint: 'Pass name:"<title>" and fields:[{name, type}].' };
    const rawFields = normaliseFieldArgs(a.fields || a.columns, notes);
    if (!rawFields.length) return { error: 'fields must list at least one column: [{name, type}] with type text | number | date | datetime | bool | select (with options) | multiselect | file.', _fixHint: 'Name the columns the automation will write.' };
    if (!draftWrap._pendingDatatables) draftWrap._pendingDatatables = [];
    const pending = draftWrap._pendingDatatables;

    if (!Array.isArray(draftWrap._datatables)) {
        return { error: 'The table list could not be read right now, so no table was staged.', _fixHint: 'Try once more; if it persists, tell the user.' };
    }
    // An unreadable identity is permissive here (Apply and Build check again).
    const access = draftWrap._datatableCreate;
    if (access && access.ok === false && access.code !== 'identity_unavailable') {
        return {
            error: access.message, code: access.code,
            _fixHint: 'Tell the user; or ask them to pick an existing table (builder_ask_questions with datatableIds).',
        };
    }
    const nameNorm = normaliseKey(name);
    const again = pending.find((e) => normaliseKey(e.name) === nameNorm);
    if (again) return stagedResult(again, notes, true);

    const same = draftWrap._datatables.find((t) => t && !t.pending && normaliseKey(t.name) === nameNorm);
    if (same) {
        const approvals = draftWrap._approvedDatatableIds;
        if (!(approvals instanceof Set) || approvals.has(same.id)) {
            return {
                datatableId: same.id, datatableKey: same.key, name: same.name,
                fields: (same.columns || []).map((c) => ({ key: c.key, type: c.type })),
                exists: true,
                note: 'A table with this name exists and the user chose it; nothing staged.',
                _next: `builder_add_datatable {op:"add_row", datatableId:"${same.id}", datatableKey:"${same.key}", values:{<columnKey>: <binding>}} — keys: ${(same.columns || []).map((c) => c.key).join(', ')}.`,
            };
        }
        // Lazy: datatableApproval imports this module's walker.
        const { choiceRequiredError } = require('./datatableApproval');
        return choiceRequiredError(same, draftWrap, { op: 'add_row', sameName: true });
    }

    const norm = normalizeFields(rawFields.map((f) => ({ ...f })), []);
    if (!norm || !norm.ok || !Array.isArray(norm.fields) || !norm.fields.length) {
        return {
            error: `The columns are not valid: ${(norm && norm.error) || 'a table needs at least one column'}.`,
            code: 'schema_invalid',
            _fixHint: 'Fix the column list: every column needs a name and one of the field types.',
        };
    }
    if (pending.length >= MAX_PENDING_TABLES) {
        return { error: `At most ${MAX_PENDING_TABLES} new tables can be proposed at once; "${name}" was not staged.`, _fixHint: 'Reuse one of the staged tables, or tell the user to apply this proposal first.' };
    }
    const used = new Set([
        ...draftWrap._datatables.map((t) => t && t.key).filter(Boolean),
        ...pending.map((e) => e.key),
    ]);
    const key = keyFromTitle(typeof a.key === 'string' && a.key.trim() ? a.key : name, 0, used);
    const entry = {
        ref: nextPendingRef(pending), name, key,
        description: strip(a.description).slice(0, 500),
        fields: norm.fields,
        scope: draftWrap._datatableCreate?.scope?.kind === 'user' ? 'personal' : 'org',
    };
    pending.push(entry);
    draftWrap._datatables = [...draftWrap._datatables, pendingCatalogEntry(entry)];
    return stagedResult(entry, notes, false);
}

function stagedResult(e, notes, repeated) {
    return {
        datatableId: e.ref, datatableKey: e.key, name: e.name,
        fields: e.fields.map((f) => ({ key: f.key, type: f.type, ...(f.options ? { options: f.options } : {}) })),
        staged: true,
        ...(repeated ? { note: 'This table was already staged in this proposal; the same id is returned.' } : {}),
        ...(notes.length ? { _hints: notes } : {}),
        _next: `Use it exactly like a real table: builder_add_datatable {op:"add_row", datatableId:"${e.ref}", datatableKey:"${e.key}", values:{<columnKey>: binding}} — keys: ${e.fields.map((f) => f.key).join(', ')}. It does NOT exist yet: it is part of the proposal and is created when the user presses Apply. Say "will be created when you apply", never that it exists.`,
    };
}

module.exports = {
    MAX_PENDING_TABLES, isPendingDatatableId, nextPendingRef, pendingCatalogEntry, walkDatatableRefs,
    collectPendingRefs, boundDatatableIds, rebindPendingDatatables, usedDatatables, withoutStagedTableIssues,
    stagePendingDatatable,
};
