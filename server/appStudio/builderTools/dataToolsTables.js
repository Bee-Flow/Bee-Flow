// @typecheck
const { FIELD_TYPES, DATA_LIMITS, SYSTEM_COLUMNS, KEY_RE: DATA_KEY_RE, newTableId, newFieldId, canonicalizeDataModel, validateDataModel, migrationPlan } = require('../dataModel');
const { isDatatableBacked } = require('../datatableSource');
const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');
const { pickClosestId, linkedTableRefusal, currentDataModel, findModelTable, tableIdHint, persistDataModel, dataModelPersistError } = require('./dataToolsShared');
const { findTableRefs, applyRemoveTable, applySetRoles } = require('./dataToolsRoles');

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

module.exports = { mergeTableOp, applyUpsertTable, findTableRefs, applyRemoveTable, applySetRoles };
