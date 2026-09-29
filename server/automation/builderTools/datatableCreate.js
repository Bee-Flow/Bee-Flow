/**
 * Builder tool — `builder_create_datatable`: create a Studio datatable at
 * DESIGN time, so a routine can be built onto a table that did not exist
 * yet ("extract the invoices into a new table called invoice"). Before this
 * the builder could only write into tables that already existed, and a
 * model asked for a new one invented a create-table STEP (measured
 * 2026-09-14: `builder_add_action` with no such tool, refused every round).
 *
 * The table is made the way the Datatables section and the Playbook table
 * phase make one (core/dataEngine/createStudioDatatable), owned by the
 * routine's owner, in their default scope; the draft's datatable catalog
 * is refreshed in place so the very next builder_add_datatable can target
 * the new id. It is a side effect outside the draft: a second call with the
 * same name answers with the table that exists, never a second table.
 */

'use strict';

const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');

const MAX_FIELDS = 40;
const FIELD_TYPES = ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file'];
const TYPE_ALIASES = { string: 'text', str: 'text', integer: 'number', int: 'number', float: 'number', decimal: 'number', currency: 'number', amount: 'number', boolean: 'bool', enum: 'select', choice: 'select', timestamp: 'datetime', attachment: 'file' };

function defaultDeps() {
    return {
        createStudioDatatable: (...a) => require('../../core/dataEngine/createStudioDatatable').createStudioDatatable(...a),
        resolvePrincipal: (userId) => require('../../auth/datatableAccess').resolveDatatablePrincipalForUser(userId),
        hasManageDatatables: async (userId) => {
            const { hasPermission, Permissions } = require('../../auth/permissions');
            return hasPermission(userId, Permissions.MANAGE_DATATABLES).catch(() => false);
        },
        catalogFor: (userId) => require('../builderDatatableCatalog').buildDatatableCatalogForUser(userId),
    };
}

/** The model's column list → the shape normalizeFields takes; notes say what was read. */
function normaliseFieldArgs(raw, notes) {
    const list = Array.isArray(raw) ? raw : [];
    const used = new Set();
    const out = [];
    list.slice(0, MAX_FIELDS).forEach((f, i) => {
        const src = f && typeof f === 'object' ? f : { name: String(f) };
        const name = String(src.name || src.label || src.title || src.key || `Kolom ${i + 1}`).trim();
        let key = typeof src.key === 'string' && /^[a-z][a-z0-9_]*$/.test(src.key) ? src.key : null;
        if (!key) {
            // An invalid key keeps its intent (slugged); no key → from the name.
            key = keyFromTitle(typeof src.key === 'string' && src.key.trim() ? src.key : name, i, used);
            if (src.key) notes.push(`fields[${i}]: key "${src.key}" read as "${key}" (lowercase letters, digits, underscores).`);
        }
        if (used.has(key)) { const k2 = keyFromTitle(key, i, used); notes.push(`fields[${i}]: key "${key}" was taken — "${k2}".`); key = k2; }
        used.add(key);
        let type = String(src.type || 'text').toLowerCase();
        if (TYPE_ALIASES[type]) { notes.push(`fields[${i}]: type "${type}" read as "${TYPE_ALIASES[type]}".`); type = TYPE_ALIASES[type]; }
        if (!FIELD_TYPES.includes(type)) { notes.push(`fields[${i}]: unknown type "${type}" read as "text".`); type = 'text'; }
        const field = { key, name, type };
        if (type === 'select' || type === 'multiselect') {
            const opts = (Array.isArray(src.options) ? src.options : []).map((o) => String(o && typeof o === 'object' ? (o.value || o.label || '') : o).trim()).filter(Boolean);
            if (!opts.length) { notes.push(`fields[${i}]: a ${type} without options read as text.`); field.type = 'text'; }
            else field.options = [...new Set(opts)];
        }
        if (src.required === true) field.required = true;
        out.push(field);
    });
    return out;
}

/**
 * @param {object} draftWrap  the builder draft (owner = draftWrap.userId; catalog on _datatables)
 * @param {object} args       { name, fields:[{key?, name, type, options?}], description?, key? }
 */
async function applyCreateDatatable(draftWrap, args, deps = defaultDeps()) {
    const a = args && typeof args === 'object' ? args : {};
    const name = String(a.name || a.title || '').trim();
    if (!name) return { error: 'name is required — the table\'s title as the person will see it in Studio > Datatables.', _fixHint: 'Pass name:"<title>" and fields:[{name, type}].' };
    const notes = [];
    const fields = normaliseFieldArgs(a.fields || a.columns, notes);
    if (!fields.length) return { error: 'fields must list at least one column: [{name, type}] with type text | number | date | datetime | bool | select (with options) | multiselect | file.', _fixHint: 'Name the columns the routine will write.' };
    const ownerId = draftWrap && draftWrap.userId;
    // The owner is the person building the draft (draftWrap.userId, set by
    // loadOrCreateDraft) — it is never something a tool call can supply, so
    // the hint must not send the model to builder_set_metadata for it.
    if (!ownerId) return { error: 'The routine has no owner yet — save the draft first.', _fixHint: 'Save the draft first (any mutation) — the owner is the person building it; no tool argument sets it.' };

    // Idempotent on the name: the catalog already lists it → that is the table.
    const catalog = Array.isArray(draftWrap._datatables) ? draftWrap._datatables : [];
    const same = catalog.find((t) => t && String(t.name || '').trim().toLowerCase() === name.toLowerCase());
    if (same) {
        return {
            datatableId: same.id, datatableKey: same.key, name: same.name,
            fields: (same.columns || []).map((c) => ({ key: c.key, type: c.type })),
            note: `A table called "${same.name}" already exists (${same.id}) — nothing was created; write into it.`,
            _next: `builder_add_datatable {op:"add_row", datatableId:"${same.id}", datatableKey:"${same.key}", values:{<columnKey>: <binding>}} — keys: ${(same.columns || []).map((c) => c.key).join(', ')}.`,
        };
    }

    let principal;
    try { principal = await deps.resolvePrincipal(ownerId); } catch (e) { principal = null; }
    if (!principal || principal.identityError) return { error: 'The owner\'s identity could not be read right now — this is an availability problem, not your arguments.', _fixHint: 'Try once more; if it persists, tell the user.' };
    const hasManage = await deps.hasManageDatatables(ownerId);
    const result = await deps.createStudioDatatable({
        ownerUserId: ownerId, principal, name, key: typeof a.key === 'string' ? a.key : null,
        description: typeof a.description === 'string' ? a.description : `Aangemaakt door de routinebouwer voor "${name}"`,
        fields, hasManageDatatables: hasManage,
    });
    if (!result.ok) {
        const hints = {
            manage_datatables_required: 'The owner may not create organisation tables (manage_datatables) — tell the user, or write into a table that exists.',
            schema_invalid: 'Fix the column list: every column needs a name and one of the field types.',
            key_taken: 'A table with that key exists — pass another name or key.',
        };
        return { error: result.error, code: result.code, _fixHint: hints[result.code] || 'Tell the user the table could not be created.' };
    }
    const { table } = result;
    // The catalog the prompt and builder_add_datatable read — refreshed in
    // place so the next call this turn sees the new table.
    const entry = { id: table.id, name: table.name, key: table.key, description: a.description || '', rowCount: 0, canWrite: true, managedKind: null, scope: table.scope.kind === 'org' ? 'org' : 'personal', columns: table.fields.map((f) => ({ key: f.key, name: f.name, type: f.type, unique: false })) };
    if (Array.isArray(draftWrap._datatables)) draftWrap._datatables.push(entry); else draftWrap._datatables = [entry];
    try {
        const fresh = await deps.catalogFor(ownerId);
        if (Array.isArray(fresh) && fresh.some((t) => t.id === table.id)) draftWrap._datatables = fresh;
    } catch { /* the in-place entry stands */ }
    return {
        datatableId: table.id,
        datatableKey: table.key,
        name: table.name,
        fields: table.fields.map((f) => ({ key: f.key, type: f.type, ...(f.options ? { options: f.options } : {}) })),
        created: true,
        ...(notes.length ? { _hints: notes } : {}),
        _next: `Write into it with builder_add_datatable {op:"add_row", datatableId:"${table.id}", datatableKey:"${table.key}", values:{<columnKey>: <binding>}} — keys: ${table.fields.map((f) => f.key).join(', ')}. The table is empty; the routine fills it.`,
    };
}

module.exports = { applyCreateDatatable, normaliseFieldArgs, FIELD_TYPES };
