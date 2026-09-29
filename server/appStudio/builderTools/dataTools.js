/**
 * App Studio builder tools — the DATA side: tables, roles, seed rows,
 * datasets, and the read/query tools over them. See the section comment
 * below for the draftWrap fields these mutate.
 */

'use strict';

const { pickClosestId } = require('../../automation/validate/helpers');
const { MAX_SEED_RECORDS } = require('./schemas');
const {
    FIELD_TYPES,
    FILTER_OPS,
    AGG_FNS,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE: DATA_KEY_RE,
    newTableId,
    newFieldId,
    canonicalizeDataModel,
    validateDataModel,
    emptyDataModel,
    migrationPlan,
} = require('../dataModel');
const { adoptCanonical } = require('./shared');
const { persistDraft } = require('./persistence');
const { isDatatableBacked } = require('../datatableSource');
const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');

/**
 * The refusal every data tool gives for a LINKED table (source: datatable).
 * Its rows live in a Studio table — a Nextcloud mirror a routine fills, an
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

// ── Data engine (per-app database) ──────────────────────────────────
//
// These tools mutate the SECOND draft the route hangs on the draftWrap: the
// data model (draftWrap.dataModel / .dataModelVersion / .rowCounts /
// .datasetIds). Model writes go through persistDataModel (the saveDataModel
// CAS seam, rebase-once on conflict); row writes go through
// actionExecutor.writeRecord — THE record-write choke point (RLS + quotas).

const DATA_CONFLICT_ERROR = 'The data model changed in another tab (version conflict) — the draft state now shows the latest tables; retry the operation against them.';
const MAX_QUERY_LIMIT = 20;
const MAX_ROLES = 20;

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
        } catch (_) { /* stale counts are advisory */ }
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

/**
 * PURE merge of one app_upsert_table call into a data model. Returns
 * { model, table, hints } or { error, _fixHint }. Never touches the input.
 */
/**
 * A field's `default` as the column will hold it, or an error.
 *
 * The tool schema types `default` as a string — the one shape every
 * provider's template renders cleanly (since 2026-09-17; untyped before), so
 * a model that follows it writes "false" on a bool and "0" on a number. The
 * DDL reads a bool default by truthiness (`value ? TRUE : FALSE`), and the
 * string "false" is truthy: `default:"false"` on a bool became `DEFAULT
 * TRUE`, the opposite of what was asked, silently (caught in review
 * 2026-09-18). So the value is read by the field's type here, once, and one
 * that cannot be read is refused rather than stored. Dates and text keep
 * the string as written.
 */
function coerceFieldDefault(value, type, at) {
    if (value === null || value === undefined) return { value };
    if (type === 'bool') {
        if (typeof value === 'boolean') return { value };
        const s = String(value).trim().toLowerCase();
        if (s === 'true' || s === '1') return { value: true };
        if (s === 'false' || s === '0' || s === '') return { value: false };
        return { error: `${at}.default ${JSON.stringify(value)} is not a boolean — a bool field's default is "true" or "false".` };
    }
    if (type === 'number') {
        const n = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(String(value).trim()));
        if (!Number.isFinite(n)) return { error: `${at}.default ${JSON.stringify(value)} is not a number — a number field's default is a numeric literal such as "0".` };
        return { value: n };
    }
    return { value };
}

function mergeTableOp(model, args, rowCounts = {}) {
    const hints = [];
    const tables = Array.isArray(model.tables) ? model.tables : [];

    let existing = null;
    if (args.tableId !== undefined && args.tableId !== null) {
        existing = tables.find((t) => t.id === args.tableId) || null;
        if (!existing) {
            const suggestion = pickClosestId(args.tableId, tables.map((t) => t.id));
            return {
                error: `Unknown tableId ${JSON.stringify(args.tableId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
                _fixHint: `${tableIdHint(model)} Omit tableId to create a new table.`,
            };
        }
    }

    // A model that learned the `source` shape must not point an app at a
    // guessed tbl_ id; the link tool resolves by name and checks the grade.
    if (!existing && args.source !== undefined) {
        return {
            error: 'app_upsert_table creates the app\'s OWN tables — to bring in a table that already exists in Studio (a Nextcloud mirror, an org table) call app_link_datatable.',
            _fixHint: 'app_link_datatable { name:"<the table\'s title>" } — it returns the tbl_ id and field keys to bind.',
        };
    }
    // A LINKED table's fields are the source's. Name/icon/access may change;
    // a differing field list is refused rather than drifting the copy.
    if (existing && isDatatableBacked(existing) && Array.isArray(args.fields)) {
        const sig = (fs) => (fs || []).map((f) => `${f && f.key}:${f && f.type}`).sort().join('|');
        if (sig(args.fields) !== sig(existing.fields)) return linkedTableRefusal(existing, 'fields');
    }

    let key = existing ? existing.key : null;
    if (args.key !== undefined && args.key !== null) {
        if (typeof args.key !== 'string' || !DATA_KEY_RE.test(args.key)) {
            return { error: `key ${JSON.stringify(args.key)} must be lowercase snake_case starting with a letter (max 63 chars), e.g. "tasks".` };
        }
        key = args.key;
    }
    // A create that names the table but not its key: the key IS the name,
    // slugged — the same derivation the Nextcloud mirror uses for column
    // titles. Measured 2026-09-13: the prompt teaches {name, fields}; a small
    // model does not add a key it was never shown, and "key is required" cost
    // a round for a value the server can spell itself.
    if (!key && !existing && typeof args.name === 'string' && args.name.trim()) {
        key = keyFromTitle(args.name, 0, new Set(tables.map((t) => t.key)));
        hints.push(`key derived from name: ${JSON.stringify(args.name)} → ${key}.`);
    }
    if (!key) return { error: 'key is required when creating a table (lowercase snake_case, e.g. "tasks") — or give the table a name and the key is derived from it.' };
    if (tables.some((t) => t !== existing && t.key === key)) {
        const holder = tables.find((t) => t !== existing && t.key === key);
        return {
            error: `A table with key "${key}" already exists (${holder.id}).`,
            _fixHint: 'Pass its tableId to evolve that table, or pick a different key.',
        };
    }

    const linkedEdit = existing && isDatatableBacked(existing);
    const rawFields = Array.isArray(args.fields) ? args.fields : (linkedEdit ? existing.fields : null);
    if (!rawFields || !rawFields.length) {
        return { error: 'fields must be a non-empty array of { key, type, … } — the table\'s COMPLETE field list.' };
    }
    if (rawFields.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        return { error: `fields: max ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} fields per table.` };
    }

    const oldFields = existing ? (existing.fields || []) : [];
    const byId = new Map(oldFields.map((f) => [f.id, f]));
    const byKey = new Map(oldFields.map((f) => [f.key, f]));
    const tableId = existing ? existing.id : newTableId();
    const rowCount = Math.max(0, parseInt(rowCounts[tableId], 10) || 0);

    const seenKeys = new Set();
    const fields = [];
    const derivedFieldKeys = [];
    for (const [i, given] of rawFields.entries()) {
        const at = `fields[${i}]`;
        if (!given || typeof given !== 'object' || Array.isArray(given)) {
            return { error: `${at} must be an object { key, type, … }.` };
        }
        // Same tolerance per field: `label` is what a form-minded model calls
        // `name`, and a field with a name but no key gets the slug of its name
        // (unique within this call). An explicit key always wins.
        const raw = { ...given };
        if (raw.name === undefined && typeof raw.label === 'string') { raw.name = raw.label; delete raw.label; }
        if ((raw.key === undefined || raw.key === null) && typeof raw.name === 'string' && raw.name.trim()) {
            raw.key = keyFromTitle(raw.name, i, new Set([...seenKeys, ...SYSTEM_COLUMNS]));
            derivedFieldKeys.push(`${JSON.stringify(raw.name)} → ${raw.key}`);
        }
        if (typeof raw.key !== 'string' || !DATA_KEY_RE.test(raw.key)) {
            return { error: `${at}.key ${JSON.stringify(raw.key)} must be lowercase snake_case starting with a letter (max 63 chars).` };
        }
        if (SYSTEM_COLUMNS.includes(raw.key)) {
            return {
                error: `${at}.key "${raw.key}" collides with a reserved system column (${SYSTEM_COLUMNS.join(', ')}).`,
                _fixHint: 'System columns exist on every table automatically — bind to them, never declare them.',
            };
        }
        if (seenKeys.has(raw.key)) return { error: `${at}.key "${raw.key}" is duplicated in this call.` };
        seenKeys.add(raw.key);
        if (!FIELD_TYPES.includes(raw.type)) {
            const suggestion = pickClosestId(raw.type, FIELD_TYPES);
            return { error: `${at}.type ${JSON.stringify(raw.type)} is not a field type.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Legal types: ${FIELD_TYPES.join(', ')}.` };
        }

        let old = null;
        if (raw.fieldId !== undefined && raw.fieldId !== null) {
            old = byId.get(raw.fieldId) || null;
            if (!old) {
                return {
                    error: `${at}.fieldId ${JSON.stringify(raw.fieldId)} does not exist on ${tableId}.`,
                    _fixHint: `Field ids on the table: ${oldFields.map((f) => f.id).join(', ') || '(none)'} — omit fieldId for a new field.`,
                };
            }
        } else {
            old = byKey.get(raw.key) || null; // same key = same field (stable id — no drop+add)
        }
        if (old && old.type !== raw.type) {
            return {
                error: `Field "${raw.key}" is ${old.type} — DDL v1 cannot convert a column's type in place (to ${raw.type}).`,
                _fixHint: 'Add a NEW field (different key) with the new type and migrate values there, or drop the old field first (its data is lost) and re-add it.',
            };
        }

        const field = {
            id: old ? old.id : newFieldId(),
            key: raw.key,
            name: (typeof raw.name === 'string' && raw.name) ? raw.name : (old ? old.name : raw.key),
            type: raw.type,
            required: raw.required === true,
            unique: raw.unique === true,
        };
        if (raw.subtype !== undefined) field.subtype = raw.subtype;
        else if (old && old.subtype !== undefined) field.subtype = old.subtype;
        if (raw.default !== undefined) {
            const coerced = coerceFieldDefault(raw.default, raw.type, at);
            if (coerced.error) return { error: coerced.error };
            field.default = coerced.value;
        } else if (old && old.default !== undefined) {
            field.default = old.default;
        }

        if (raw.type === 'select' || raw.type === 'multiselect') {
            const options = Array.isArray(raw.options) ? raw.options
                : (old && Array.isArray(old.options) ? old.options : []);
            if (!options.length) return { error: `${at} (${raw.type}) requires a non-empty options array (strings or {value,label}).` };
            field.options = options;
        }
        if (raw.type === 'relation') {
            const rel = (raw.relation && typeof raw.relation === 'object') ? raw.relation : null;
            const target = rel ? (rel.tableId || rel.table) : (old && old.relation ? old.relation.table : null);
            if (typeof target !== 'string' || !target) {
                return { error: `${at} (relation) requires relation: { tableId } — the tbl_… id of the table it points at.`, _fixHint: tableIdHint(model) };
            }
            field.relation = { table: target };
            const display = rel ? (rel.displayFieldKey || rel.displayField) : (old && old.relation ? old.relation.displayField : null);
            if (typeof display === 'string' && display) field.relation.displayField = display;
        }
        if (raw.type === 'computed') {
            const comp = (raw.computed && typeof raw.computed === 'object') ? raw.computed : (old ? old.computed : null);
            if (!comp || typeof comp.expr !== 'string' || !comp.expr.trim()) {
                return { error: `${at} (computed) requires computed: { expr, type? }.` };
            }
            // `stored` decides whether this is a real column (filterable,
            // sortable, aggregatable) or a read-time expression, and it used
            // to be dropped here — rebuilt from expr and type alone. Two ways
            // that bit: a stored column could not be authored through this
            // tool at all, and re-sending an existing table (to edit some
            // OTHER field) silently DOWNGRADED one to read-time. Every filter
            // and aggregate on it then failed with "is a read-time computed
            // field and cannot be queried", from a call that never mentioned
            // it. So: an explicit value wins, otherwise inherit what the field
            // already was — a caller who says nothing changes nothing.
            const stored = typeof comp.stored === 'boolean'
                ? comp.stored
                : Boolean(old && old.computed && old.computed.stored);
            field.computed = { expr: comp.expr, ...(comp.type ? { type: comp.type } : {}), ...(stored ? { stored: true } : {}) };
        }

        // DDL v1: a NOT NULL column can't be ADDed to a populated table without
        // a default — the column lands nullable; teach instead of surprising.
        if (field.required && (field.default === undefined || field.default === null)
            && !old && existing && rowCount > 0) {
            hints.push(`Field "${field.key}" is required with no default on a table holding ${rowCount} row(s) — the ${rowCount} existing row(s) keep it empty and only NEW writes enforce it. Give it a default to backfill.`);
        }
        fields.push(field);
    }

    if (derivedFieldKeys.length) hints.push(`field keys derived from names: ${derivedFieldKeys.join(', ')}.`);

    // Relation targets must resolve within the NEXT model (self-relations ok).
    const knownIds = new Set(tables.map((t) => t.id));
    knownIds.add(tableId);
    for (const f of fields) {
        if (f.type === 'relation' && !knownIds.has(f.relation.table)) {
            return {
                error: `Field "${f.key}" points at unknown table ${JSON.stringify(f.relation.table)}.`,
                _fixHint: `${tableIdHint(model)} Create the parent table first (one app_upsert_table call per table), then reference its returned tbl_… id.`,
            };
        }
    }

    const dropped = oldFields.filter((f) => !fields.some((nf) => nf.id === f.id));
    if (dropped.length) {
        hints.push(`Dropped field(s) ${dropped.map((f) => f.key).join(', ')} — they were missing from fields[] (the array is the COMPLETE field list); their column data is deleted.`);
    }

    const table = {
        ...(existing || {}),
        id: tableId,
        key,
        name: (typeof args.name === 'string' && args.name) ? args.name : (existing ? existing.name : key),
        icon: args.icon !== undefined ? args.icon : (existing ? existing.icon : null),
        fields,
    };
    if (args.access !== undefined) {
        if (!args.access || typeof args.access !== 'object' || Array.isArray(args.access)) {
            return { error: 'access must be an object { default, roles?, rowFilters? }.' };
        }
        table.access = args.access;
    }

    const nextTables = existing ? tables.map((t) => (t.id === tableId ? table : t)) : [...tables, table];
    if (!existing && nextTables.length > DATA_LIMITS.MAX_TABLES_PER_APP) {
        return { error: `The app already has ${DATA_LIMITS.MAX_TABLES_PER_APP} tables (the maximum).` };
    }
    return { model: { ...model, tables: nextTables }, table, hints };
}

/** Compact human summary of a migration plan for the tool result. */
function summariseMigration(plan) {
    if (!Array.isArray(plan) || !plan.length) return 'no schema change';
    const shown = plan.slice(0, 8).map((s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80));
    if (plan.length > 8) shown.push(`… +${plan.length - 8} more`);
    return shown.join('; ');
}

async function applyUpsertTable(draftWrap, args) {
    const base = currentDataModel(draftWrap);
    const op = (model) => mergeTableOp(model, args, draftWrap.rowCounts || {});
    const merged = op(base);
    if (merged.error) return merged;

    const { model: canonical } = canonicalizeDataModel(merged.model);
    const check = validateDataModel(canonical);
    if (check.errors.length) {
        return {
            error: 'The resulting data model would be invalid — fix every error below, then call the tool again.',
            errors: check.errors,
            _fixHint: 'Table/field keys are lowercase snake_case; relations must point at existing tbl_… ids.',
        };
    }
    // Row filters are the only free-form expressions a data model carries — the
    // AI write passes the SAME save-time gate as the human PUT /:id/schema path.
    const { validateRowFilter } = require('../rlsGateway');
    const canonTable = findModelTable(canonical, merged.table.id) || merged.table;
    const rowFilters = (canonTable.access && typeof canonTable.access.rowFilters === 'object') ? canonTable.access.rowFilters : null;
    const rowFilterErrors = [];
    for (const roleKey of Object.keys(rowFilters || {})) {
        const { ok, errors } = validateRowFilter(rowFilters[roleKey], canonTable);
        if (!ok) rowFilterErrors.push(`role "${roleKey}": ${errors.join('; ')}`);
    }
    if (rowFilterErrors.length) {
        return {
            error: `access.rowFilters on "${canonTable.key}" are not expressible as a row filter — fix every error below, then call the tool again.`,
            errors: rowFilterErrors,
            _fixHint: 'A row filter compares record.<field> / viewer.<attr> / literals with == != < <= > >= combined by && || ! — no function calls, arithmetic or bracket access.',
        };
    }
    const plan = migrationPlan(base, canonical);

    const persisted = await persistDataModel(draftWrap, canonical, {
        rebase: (serverModel) => {
            const re = op(serverModel);
            if (re.error) return re;
            return canonicalizeDataModel(re.model).model;
        },
    });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;

    const saved = findModelTable(draftWrap.dataModel, merged.table.id) || merged.table;
    const result = {
        tableId: saved.id,
        key: saved.key,
        fields: (saved.fields || []).map((f) => ({ fieldId: f.id, key: f.key, type: f.type })),
        modelVersion: draftWrap.dataModelVersion,
        migration: summariseMigration(plan),
        rowCount: (draftWrap.rowCounts && draftWrap.rowCounts[saved.id]) || 0,
    };
    if (merged.hints.length) result._hints = merged.hints;
    return result;
}

/**
 * Everywhere the definition still references a table id: node props carrying
 * record/records bindings or a relation input's tableId, and action/step
 * fields. Used by app_remove_table's refusal (teach, don't destroy).
 */
function findTableRefs(def, tableId) {
    const refs = new Set();
    const scan = (value, where) => {
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && value.tableId === tableId) { refs.add(where); return; }
        for (const v of Object.values(value)) scan(v, where);
    };
    const walkNode = (node) => {
        scan(node.props, `component ${node.id}`);
        for (const c of node.children || []) walkNode(c);
    };
    for (const s of def.screens || []) {
        for (const sec of s.sections || []) {
            for (const n of sec.children || []) walkNode(n);
        }
    }
    for (const [id, action] of Object.entries(def.actions || {})) scan(action, `action ${id}`);
    return [...refs];
}

async function applyRemoveTable(draftWrap, args) {
    const model = currentDataModel(draftWrap);
    const tableId = typeof args?.tableId === 'string' ? args.tableId : null;
    const table = tableId ? (model.tables || []).find((t) => t.id === tableId) : null;
    if (!table) {
        const suggestion = pickClosestId(tableId, (model.tables || []).map((t) => t.id));
        return { error: `Unknown tableId ${JSON.stringify(tableId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: tableIdHint(model) };
    }
    const refs = findTableRefs(draftWrap.def, tableId);
    if (refs.length) {
        return {
            error: `Cannot remove ${tableId} ("${table.name}") — the definition still references it: ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ` and ${refs.length - 8} more` : ''}.`,
            _fixHint: 'Re-bind or remove those components/steps first, then remove the table.',
        };
    }
    const rowCount = (draftWrap.rowCounts && draftWrap.rowCounts[tableId]) || 0;
    const op = (m) => ({ ...m, tables: (Array.isArray(m.tables) ? m.tables : []).filter((t) => t.id !== tableId) });
    const persisted = await persistDataModel(draftWrap, op(model), { rebase: op });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;
    return {
        removed: tableId,
        modelVersion: draftWrap.dataModelVersion,
        ...(rowCount ? { note: `The table and its ${rowCount} row(s) were deleted.` } : {}),
    };
}

async function applySetRoles(draftWrap, args) {
    const rawRoles = Array.isArray(args?.roles) ? args.roles : null;
    if (!rawRoles || !rawRoles.length) return { error: 'roles must be a non-empty array of { key, label }.' };
    if (rawRoles.length > MAX_ROLES) return { error: `roles: max ${MAX_ROLES} roles.` };
    const seen = new Set();
    const roles = [];
    for (const [i, r] of rawRoles.entries()) {
        if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !DATA_KEY_RE.test(r.key)) {
            return { error: `roles[${i}].key must be lowercase snake_case starting with a letter (e.g. "manager").` };
        }
        if (seen.has(r.key)) return { error: `roles[${i}].key "${r.key}" is duplicated.` };
        seen.add(r.key);
        roles.push({ key: r.key, label: (typeof r.label === 'string' && r.label) ? r.label : r.key });
    }

    const model = currentDataModel(draftWrap);
    let roleMapping = (model.roleMapping && typeof model.roleMapping === 'object')
        ? model.roleMapping : { default: 'app', byGroup: {} };
    if (args?.roleMapping !== undefined) {
        const rm = args.roleMapping;
        if (!rm || typeof rm !== 'object' || Array.isArray(rm)) {
            return { error: 'roleMapping must be an object { default?, byGroup? }.' };
        }
        const nextDefault = rm.default !== undefined ? rm.default : roleMapping.default;
        // '' is the explicit "no access" default — rlsGateway.resolveViewerRole
        // reads a blank default as "no role, so no data", and the editor's role
        // manager persists exactly that. Rejecting it here would make every
        // set_roles call fail on an app the owner deliberately locked down.
        if (typeof nextDefault !== 'string' || (nextDefault !== 'app' && nextDefault !== '' && !seen.has(nextDefault))) {
            return { error: `roleMapping.default ${JSON.stringify(rm.default)} must be one of the role keys (${roles.map((x) => x.key).join(', ')}), "app", or "" for no access.` };
        }
        const byGroup = (rm.byGroup && typeof rm.byGroup === 'object' && !Array.isArray(rm.byGroup)) ? rm.byGroup : roleMapping.byGroup || {};
        for (const [group, roleKey] of Object.entries(byGroup)) {
            if (!seen.has(roleKey)) {
                return { error: `roleMapping.byGroup[${JSON.stringify(group)}] = ${JSON.stringify(roleKey)} is not a defined role key.` };
            }
        }
        roleMapping = { default: nextDefault, byGroup };
    }

    // Whether the app may read the organisation's member list — the switch that
    // makes `input_person` and the reserved `sys_org_members` dataset work. It
    // lives with roles because it answers the same question: who this app can
    // see. Absent means unchanged, so a set_roles call that says nothing about
    // it cannot silently turn it on OR off.
    let directory = model.directory;
    if (args?.orgDirectory !== undefined) {
        if (typeof args.orgDirectory !== 'boolean') {
            return { error: 'orgDirectory must be true or false.' };
        }
        directory = { orgMembers: args.orgDirectory };
    }

    const op = (m) => ({ ...m, roles, roleMapping, ...(directory ? { directory } : {}) });
    const persisted = await persistDataModel(draftWrap, op(model), { rebase: op });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;

    // Mirror into definition.roles ([{id,name}] — drives visibleToRoles) so
    // both stores stay lockstep. The route persists the definition right after
    // (this tool is in MUTATING_TOOLS).
    const next = { ...draftWrap.def, roles: roles.map((r) => ({ id: r.key, name: r.label })) };
    return adoptCanonical(draftWrap, next, {
        roles: roles.map((r) => r.key),
        roleMapping,
        orgDirectory: directory?.orgMembers === true,
        modelVersion: draftWrap.dataModelVersion,
    });
}

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
            try { await studioAppDataStore.deleteDataset(row.id, draftWrap.appId, draftWrap.userId); } catch (_) { /* best-effort */ }
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
        data: renderDataBlock(draftWrap.dataModel ?? null, draftWrap.datasetIds, draftWrap.rowCounts, draftWrap.linkedTables || null),
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

// app_list_documents — the OWNER's designed documents, with the placeholders
// each one carries. Read-only, and the analogue of app_list_connectors: the AI
// WIRES an existing document into a fill_document step; it never authors one,
// because the layout is the thing a person drew by hand.
//
// Owner-scoped (documentStore.getDocument/listTemplates take a userId), and the
// owner is the app's — an app prints on the company's letterhead, not on the
// letterhead of whoever pressed the button.
async function applyListDocuments(draftWrap) {
    const documentStore = require('../../stores/documentStore');
    let templates = [];
    try {
        templates = await documentStore.listTemplates(draftWrap.userId, { limit: 50 });
    } catch (e) {
        // An outage is not "the owner has no documents": saying so would send
        // the model off to build a text export instead of asking again.
        return { error: `The documents could not be read (${e.message}).`, _fixHint: 'Try again; do not build a substitute document out of text.' };
    }
    return {
        documents: templates.map(t => ({
            ...t,
            documentId: t.id,
            name: t.name,
            docType: t.docType,
            placeholders: t.placeholders,
        })),
        note: templates.length
            ? 'Use one of these documentIds in a fill_document step; the keys of `values` are the placeholder names exactly as listed. A "list" placeholder needs a binding that resolves to an array.'
            : 'No designed documents yet — the owner makes them in Studio → Documents. You cannot create one; say so instead of exporting text as a substitute.',
    };
}

async function applyQueryData(draftWrap, args) {
    const model = draftWrap.dataModel;
    if (!draftWrap.appId || !model || !Array.isArray(model.tables) || !model.tables.length) {
        return { error: 'The app has no data tables yet — create one with app_upsert_table and seed it first.' };
    }
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, parseInt(args?.limit, 10) || 5));
    const studioAppStore = require('../../stores/studioAppStore');
    let app = null;
    try { app = await studioAppStore.getStudioApp(draftWrap.appId); } catch (_) { app = null; }
    if (!app) return { error: 'This app no longer exists — it may have been deleted in another tab.' };

    try {
        if (args?.datasetId) {
            const studioAppDataStore = require('../../stores/studioAppDataStore');
            const ds = await studioAppDataStore.getDataset(args.datasetId, draftWrap.appId, draftWrap.userId);
            if (!ds) {
                const known = (draftWrap.datasetIds || []).map((d) => (d && d.id) || d).filter(Boolean);
                return { error: `Unknown datasetId ${JSON.stringify(args.datasetId)}.`, _fixHint: `Known datasets: ${known.join(', ') || '(none)'}.` };
            }
            const datasetCache = require('../datasetCache');
            const out = await datasetCache.runDataset(app, model, ds, { id: draftWrap.userId, role: 'owner' });
            const rows = Array.isArray(out.rows) ? out.rows : [];
            return { rows: rows.slice(0, limit), rowCount: rows.length };
        }
        const table = findModelTable(model, args?.tableId);
        if (!table) {
            return { error: `Unknown tableId ${JSON.stringify(args?.tableId)}.`, _fixHint: tableIdHint(model) };
        }
        if (isDatatableBacked(table)) {
            // The rows are in the Studio table, not the per-app database: read
            // them the way the app runtime does (grade-checked, stale-while-
            // serve for a Nextcloud mirror). A peek at five real rows is what a
            // small model needs before it binds.
            const dataReadRunner = require('../dataReadRunner');
            const ctx = { app, ownerScope: app.userId, viewerId: draftWrap.userId, role: 'owner', viewer: { id: draftWrap.userId, role: 'owner' }, model };
            try {
                const out = await dataReadRunner.runRecordList(ctx, table, {
                    filters: Array.isArray(args?.filter) ? args.filter : undefined,
                    sort: args?.sort,
                    limit,
                });
                const rows = Array.isArray(out.records) ? out.records : [];
                return { rows, rowCount: rows.length, ...(out.nextCursor ? { more: true } : {}), linked: true };
            } catch (e) {
                return {
                    error: `The linked Studio table could not be read: ${e.safe || e.message}`,
                    _fixHint: 'This is an access or availability problem with the Studio table, not your arguments — bind the table anyway; the app reads it live.',
                };
            }
        }
        const queryCompiler = require('../queryCompiler');
        const rlsGateway = require('../rlsGateway');
        const studioAppDbStore = require('../../stores/studioAppDbStore');
        const accessFilter = rlsGateway.compileAccessFilter(table, 'owner', { id: draftWrap.userId }, 'read');
        const { sql, params } = queryCompiler.compileRecordList(table, {
            filters: Array.isArray(args?.filter) ? args.filter : undefined,
            sort: args?.sort,
            limit,
        }, accessFilter);
        const out = await studioAppDbStore.query(draftWrap.userId, draftWrap.appId, sql, params);
        const all = Array.isArray(out.rows) ? out.rows : [];
        const rows = all.slice(0, limit); // compileRecordList fetches one probe row
        return { rows, rowCount: rows.length, ...(all.length > limit ? { more: true } : {}) };
    } catch (e) {
        return {
            error: `Query failed: ${e.message}`,
            _fixHint: `filter is [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}; fields must exist on the table (or be system columns).`,
        };
    }
}

module.exports = {
    persistDataModel,
    dataModelPersistError,
    applyUpsertTable,
    applyRemoveTable,
    applySetRoles,
    applySeedRecords,
    applyUpsertDataset,
    applyGetDataModel,
    applyListConnectors,
    applyListDocuments,
    applyQueryData,
    // internals re-exported through ../builderTools.js _test (rowCountsById is
    // also the template installer's counts normalizer)
    mergeTableOp,
    findTableRefs,
    rowCountsById,
    linkedTableRefusal,
    MAX_QUERY_LIMIT,
};
