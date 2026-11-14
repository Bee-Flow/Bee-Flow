// @typecheck
const { DATA_LIMITS, KEY_RE: DATA_KEY_RE, newTableId, canonicalizeDataModel, validateDataModel, fieldConversion, migrationPlan } = require('../dataModel');
const { summariseMigration } = require('../../stores/studioAppData/migrationPreview.mts');
const { isDatatableBacked } = require('../datatableSource');
const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');
const { pickClosestId, linkedTableRefusal, currentDataModel, findModelTable, tableIdHint, persistDataModel, dataModelPersistError } = require('./dataToolsShared');
const { findTableRefs, applyRemoveTable, applySetRoles } = require('./dataToolsRoles');
const { normaliseFieldSpec, checkFieldSpec, priorField, buildField } = require('./dataToolsFields');
const { readTimeComputedError, READ_TIME_FUNCTIONS } = require('../../core/dataEngine/queryCompilerComputed.mts');


/**
 * The table a call evolves (by tableId), or null for a create. A create may
 * not carry a `source`: a model that learned that shape must not point an app
 * at a guessed tbl_ id; the link tool resolves by name and checks the grade.
 * A LINKED table's fields are the source's: name/icon/access may change, a
 * differing field list is refused rather than drifting the copy.
 * @returns {{ existing: any } | { refusal: import('./dataTools').TableMerge }}
 */
function existingTableOf(model, args, tables) {
    let existing = null;
    if (args.tableId !== undefined && args.tableId !== null) {
        existing = tables.find((t) => t.id === args.tableId) || null;
        if (!existing) {
            const suggestion = pickClosestId(args.tableId, tables.map((t) => t.id));
            return { refusal: {
                error: `Unknown tableId ${JSON.stringify(args.tableId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
                _fixHint: `${tableIdHint(model)} Omit tableId to create a new table.`,
            } };
        }
    }
    if (!existing && args.source !== undefined) {
        return { refusal: {
            error: 'app_upsert_table creates the app\'s OWN tables — to bring in a table that already exists in Studio (a Nextcloud mirror, an org table) call app_link_datatable.',
            _fixHint: 'app_link_datatable { name:"<the table\'s title>" } — it returns the tbl_ id and field keys to bind.',
        } };
    }
    if (existing && isDatatableBacked(existing) && Array.isArray(args.fields)) {
        const sig = (fs) => (fs || []).map((f) => `${f && f.key}:${f && f.type}`).sort().join('|');
        if (sig(args.fields) !== sig(existing.fields)) return { refusal: linkedTableRefusal(existing, 'fields') };
    }
    return { existing };
}

/**
 * The table's key: the given one, the existing one, or for a create that names
 * the table but not its key, the name slugged (the derivation the Nextcloud
 * mirror uses for column titles). Measured 2026-09-13: the prompt teaches
 * {name, fields}; a small model does not add a key it was never shown, and
 * "key is required" cost a round for a value the server can spell itself.
 * @returns {{ key: string } | { refusal: import('./dataTools').TableMerge }}
 */
function tableKeyOf(args, existing, tables, hints) {
    let key = existing ? existing.key : null;
    if (args.key !== undefined && args.key !== null) {
        if (typeof args.key !== 'string' || !DATA_KEY_RE.test(args.key)) { // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- DATA_KEY_RE is an anchored key pattern without nested quantifiers
            return { refusal: { error: `key ${JSON.stringify(args.key)} must be lowercase snake_case starting with a letter (max 63 chars), e.g. "tasks".` } };
        }
        key = args.key;
    }
    if (!key && !existing && typeof args.name === 'string' && args.name.trim()) {
        key = keyFromTitle(args.name, 0, new Set(tables.map((t) => t.key)));
        hints.push(`key derived from name: ${JSON.stringify(args.name)} → ${key}.`);
    }
    if (!key) return { refusal: { error: 'key is required when creating a table (lowercase snake_case, e.g. "tasks") — or give the table a name and the key is derived from it.' } };
    const holder = tables.find((t) => t !== existing && t.key === key);
    if (holder) {
        return { refusal: {
            error: `A table with key "${key}" already exists (${holder.id}).`,
            _fixHint: 'Pass its tableId to evolve that table, or pick a different key.',
        } };
    }
    return { key };
}

/**
 * The COMPLETE field list the call sends; an edit of a linked table that sends
 * none keeps the source's.
 * @returns {{ rawFields: any[] } | { refusal: import('./dataTools').TableMerge }}
 */
function rawFieldsOf(args, existing) {
    const linkedEdit = existing && isDatatableBacked(existing);
    const rawFields = Array.isArray(args.fields) ? args.fields : (linkedEdit ? existing.fields : null);
    if (!rawFields || !rawFields.length) {
        return { refusal: { error: 'fields must be a non-empty array of { key, type, … } — the table\'s COMPLETE field list.' } };
    }
    if (rawFields.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        return { refusal: { error: `fields: max ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} fields per table.` } };
    }
    return { rawFields };
}

/**
 * One entry of fields[]: checked, matched to the field it evolves, built, and
 * its type change checked. Pushes its hints. A NOT NULL column cannot be ADDed
 * to a populated table without a default (DDL v1): the column lands nullable,
 * so the hint teaches instead of surprising.
 * @returns {{ field: any, isNew: boolean } | { refusal: import('./dataTools').TableMerge }}
 */
function mergeOneField(given, i, run) {
    const at = `fields[${i}]`;
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
        return { refusal: { error: `${at} must be an object { key, type, … }.` } };
    }
    const checked = checkFieldSpec(normaliseFieldSpec(given, i, run.seenKeys, run.derivedFieldKeys), at, run.seenKeys);
    if (checked.error) return { refusal: checked };
    const raw = checked.spec;
    const prior = priorField(raw, at, run.lookup);
    if (prior.error) return { refusal: prior };
    const old = prior.old;
    const built = buildField(raw, old, at, run.model);
    if (built.error) return { refusal: built };
    const field = built.field;
    const conversion = conversionCheck(old, field, run.rowCount);
    if (conversion.error) return { refusal: conversion };
    if (conversion.hint) run.hints.push(conversion.hint);
    if (field.required && (field.default === undefined || field.default === null)
        && !old && run.existing && run.rowCount > 0) {
        run.hints.push(`Field "${field.key}" is required with no default on a table holding ${run.rowCount} row(s) — the ${run.rowCount} existing row(s) keep it empty and only NEW writes enforce it. Give it a default to backfill.`);
    }
    return { field, isNew: !old };
}

/**
 * Every entry of fields[], in order; then the hints that need the whole list
 * (a read-time expression may name a field listed after it) and the derived keys.
 * @returns {{ fields: any[] } | { refusal: import('./dataTools').TableMerge }}
 */
function mergeFields(model, rawFields, existing, { tableId, rowCount, oldFields, hints }) {
    const run = {
        model, existing, rowCount, hints, seenKeys: new Set(), derivedFieldKeys: [],
        lookup: { byId: new Map(oldFields.map((f) => [f.id, f])), byKey: new Map(oldFields.map((f) => [f.key, f])), oldFields, tableId },
    };
    const fields = [];
    const added = []; // fields new in this call
    for (const [i, given] of rawFields.entries()) {
        const one = mergeOneField(given, i, run);
        if ('refusal' in one) return one;
        if (one.isNew) added.push(one.field);
        fields.push(one.field);
    }
    for (const f of added) {
        const readTime = readTimeHint(f, fields);
        if (readTime) hints.push(readTime);
    }
    if (run.derivedFieldKeys.length) hints.push(`field keys derived from names: ${run.derivedFieldKeys.join(', ')}.`);
    return { fields };
}

/** Relation targets must resolve within the NEXT model (self-relations ok). */
function relationRefusal(model, tables, tableId, fields) {
    const knownIds = new Set(tables.map((t) => t.id));
    knownIds.add(tableId);
    const f = fields.find((x) => x.type === 'relation' && !knownIds.has(x.relation.table));
    if (!f) return null;
    return {
        error: `Field "${f.key}" points at unknown table ${JSON.stringify(f.relation.table)}.`,
        _fixHint: `${tableIdHint(model)} Create the parent table first (one app_upsert_table call per table), then reference its returned tbl_… id.`,
    };
}

/**
 * The table as stored: name, icon and access as given or kept; declared
 * indexes (schema 3, the catalogue's tableOption.indexes): given replaces,
 * null removes, absent keeps.
 * @returns {{ table: any } | { refusal: import('./dataTools').TableMerge }}
 */
function assembleTable(existing, args, { tableId, key, fields }) {
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
            return { refusal: { error: 'access must be an object { default, roles?, rowFilters? }.' } };
        }
        table.access = args.access;
    }
    if (args.indexes === null) delete table.indexes;
    else if (args.indexes !== undefined) table.indexes = args.indexes;
    return { table };
}

/** The model's tables with this one evolved or added; null when a create would pass the app's table limit. */
function nextTablesOf(tables, existing, table) {
    if (existing) return tables.map((t) => (t.id === table.id ? table : t));
    const nextTables = [...tables, table];
    return nextTables.length > DATA_LIMITS.MAX_TABLES_PER_APP ? null : nextTables;
}

/** The fields an evolve leaves out: the array is the complete list, so their data goes. */
function droppedFieldsHint(oldFields, fields) {
    const dropped = oldFields.filter((f) => !fields.some((nf) => nf.id === f.id));
    if (!dropped.length) return null;
    return `Dropped field(s) ${dropped.map((f) => f.key).join(', ')} — they were missing from fields[] (the array is the COMPLETE field list); their column data is deleted.`;
}

/**
 * PURE merge of one app_upsert_table call into a data model. Returns
 * { model, table, hints } or { error, _fixHint }. Never touches the input.
 * @returns {import('./dataTools').TableMerge}
 */
function mergeTableOp(model, args, rowCounts = {}) {
    /** @type {string[]} */
    const hints = [];
    const tables = Array.isArray(model.tables) ? model.tables : [];
    const found = existingTableOf(model, args, tables);
    if ('refusal' in found) return found.refusal;
    const { existing } = found;
    const keyed = tableKeyOf(args, existing, tables, hints);
    if ('refusal' in keyed) return keyed.refusal;
    const given = rawFieldsOf(args, existing);
    if ('refusal' in given) return given.refusal;

    const oldFields = existing ? (existing.fields || []) : [];
    const tableId = existing ? existing.id : newTableId();
    const rowCount = Math.max(0, parseInt(rowCounts[tableId], 10) || 0);
    const merged = mergeFields(model, given.rawFields, existing, { tableId, rowCount, oldFields, hints });
    if ('refusal' in merged) return merged.refusal;
    const { fields } = merged;
    const relation = relationRefusal(model, tables, tableId, fields);
    if (relation) return relation;

    const dropped = droppedFieldsHint(oldFields, fields);
    if (dropped) hints.push(dropped);
    const assembled = assembleTable(existing, args, { tableId, key: keyed.key, fields });
    if ('refusal' in assembled) return assembled.refusal;
    const { table } = assembled;
    const nextTables = nextTablesOf(tables, existing, table);
    if (!nextTables) return { error: `The app already has ${DATA_LIMITS.MAX_TABLES_PER_APP} tables (the maximum).` };
    return { model: { ...model, tables: nextTables }, table, hints };
}

/**
 * A field whose type changes: an error for a pair that does not convert in
 * place, a hint for one that does (the save converts every row).
 * @returns {{ error?: string, _fixHint?: string, hint?: string }}
 */
function conversionCheck(old, field, rowCount) {
    const conv = old ? fieldConversion(old, field) : null;
    if (!conv) return {};
    if (!conv.safe) {
        return {
            error: `Field "${field.key}" is ${conv.from} — only text↔select, number↔text, integer↔text and integer↔number convert in place (not to ${conv.to}).`,
            _fixHint: 'Add a NEW field (different key) with the new type and fill it from the old one, or drop the old field first (its data is lost) and re-add it. dryRun:true shows what a change does to the rows.',
        };
    }
    return {
        hint: `Field "${field.key}" converts ${conv.from} → ${conv.to} on save${rowCount ? ` (${rowCount} row(s))` : ''}. Values that cannot convert refuse the save unless onUnconvertible:"clear"; dryRun:true counts them first.`,
    };
}

/**
 * A NEW read-time computed field: what it can do, or why it reads empty. Said
 * once, when it is added.
 */
function readTimeHint(field, fields) {
    if (field.type !== 'computed' || !field.computed || field.computed.stored === true) return null;
    const refused = readTimeComputedError(field, { fields });
    if (refused) {
        return `Field "${field.key}" is a read-time computed field and reads empty: ${refused}. Name only this table's own columns (not another read-time computed field) and functions both database engines have (${[...READ_TIME_FUNCTIONS].join(', ')}), or pass computed.stored:true.`;
    }
    return `Field "${field.key}" is a read-time computed field: it is worked out on every read and can be shown, but not filtered, sorted or aggregated. Pass computed.stored:true for a column you can filter and sort on.`;
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
    const { validateRowFilter, rowFilterWarnings: warningsOf } = require('../rlsGateway');
    const canonTable = findModelTable(canonical, merged.table.id) || merged.table;
    const rowFilters = (canonTable.access && typeof canonTable.access.rowFilters === 'object') ? canonTable.access.rowFilters : null;
    /** @type {string[]} */
    const rowFilterErrors = [];
    /** @type {string[]} */
    const rowFilterWarnings = [];
    for (const roleKey of Object.keys(rowFilters || {})) {
        const { ok, errors } = validateRowFilter(rowFilters[roleKey], canonTable);
        if (!ok) rowFilterErrors.push(`role "${roleKey}": ${errors.join('; ')}`);
        for (const w of warningsOf(rowFilters[roleKey], canonTable)) rowFilterWarnings.push(`access.rowFilters role "${roleKey}": ${w}`);
    }
    if (rowFilterErrors.length) {
        return {
            error: `access.rowFilters on "${canonTable.key}" are not expressible as a row filter — fix every error below, then call the tool again.`,
            errors: rowFilterErrors,
            _fixHint: 'A row filter compares record.<field> / viewer.<attr> / literals with == != < <= > >= combined by && || ! — no function calls, arithmetic or bracket access. viewer has id, role, email, orgId and the list groups; a list only stands in `record.<text field> in viewer.groups`. One string per role, or { read, update, delete } with a string each: an operation left out follows read, and `true` gives it every row.',
        };
    }
    const onUnconvertible = args.onUnconvertible === 'clear' ? 'clear' : 'refuse';
    if (args.dryRun === true) return dryRunUpsert(draftWrap, canonical, merged, onUnconvertible);

    const persisted = await persistDataModel(draftWrap, canonical, {
        rebase: (serverModel) => {
            const re = op(serverModel);
            if (re.error) return re;
            return canonicalizeDataModel(re.model).model;
        },
        saveOpts: { convertTypes: true, onUnconvertible },
    });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;

    const saved = findModelTable(draftWrap.dataModel, merged.table.id) || merged.table;
    const report = /** @type {{ report?: import('../../stores/studioAppData/migrationPreview.mts').MigrationReport | null }} */ (persisted).report || null;
    /** @type {Record<string, unknown>} */
    const result = {
        tableId: saved.id,
        key: saved.key,
        fields: (saved.fields || []).map((f) => ({ fieldId: f.id, key: f.key, type: f.type })),
        modelVersion: draftWrap.dataModelVersion,
        // A store without a report (an older stub) gets the plan line as before.
        migration: report ? report.summary : summariseMigration(migrationPlan(base, canonical)),
        rowCount: (draftWrap.rowCounts && draftWrap.rowCounts[saved.id]) || 0,
        ...reportLists(report),
    };
    const hints = [...merged.hints, ...rowFilterWarnings];
    if (hints.length) result._hints = hints;
    return result;
}

/** The non-empty recomputed / converted / unsupported lists of a migration report. */
function reportLists(report) {
    const out = {};
    for (const k of ['recomputed', 'converted', 'unsupported']) {
        if (report && Array.isArray(report[k]) && report[k].length) out[k] = report[k];
    }
    return out;
}

/** app_upsert_table { dryRun:true }: what the save would do to the rows; nothing is written. */
async function dryRunUpsert(draftWrap, canonical, merged, onUnconvertible) {
    if (!draftWrap.appId) {
        return { dryRun: true, migration: 'no schema change (the app has no rows yet)', recomputed: [], converted: [], unsupported: [] };
    }
    const studioAppDataStore = require('../../stores/studioAppDataStore');
    const res = await studioAppDataStore.previewDataModelChange(draftWrap.appId, draftWrap.userId, canonical, { onUnconvertible });
    if (!res.ok) return dataModelPersistError({ invalid: true, errors: res.errors || [] });
    const r = res.report;
    const out = {
        dryRun: true, saved: false, tableId: merged.table.id, modelVersion: res.currentVersion,
        migration: r.summary, recomputed: r.recomputed, converted: r.converted, unsupported: r.unsupported,
    };
    if (r.converted.some((c) => c.unconvertible)) {
        out._fixHint = 'Some values cannot convert: fix those rows first (app_update_records), or save with onUnconvertible:"clear" to empty them.';
    }
    if (merged.hints.length) out._hints = merged.hints;
    return out;
}

module.exports = { mergeTableOp, applyUpsertTable, findTableRefs, applyRemoveTable, applySetRoles };
