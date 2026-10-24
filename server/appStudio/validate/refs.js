/**
 * App Studio validator — cross-cutting reference resolution: tables, datasets,
 * connectors, fields, automations and modals, plus the navigate-params and
 * inputMapping grammars that resolve against the collected ids.
 */

'use strict';

const { LIMITS, FORMULA_SCOPE_ROOTS, INPUT_MAPPING_KINDS } = require('../componentSpecs');
const { pickClosestId } = require('../../automation/validate/helpers');
// Data-engine vocabularies (single source of truth for the per-app database):
// the filter-op grammar, the system columns every table carries, and the
// table-source vocabulary (waar de rijen van een tabel staan).
const {
    SYSTEM_COLUMNS,
    RESERVED_DATASET_IDS,
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
} = require('../dataModel');
const { isObject, pushDataRef } = require('./shared');
const { validateFormula } = require('./formulas');

// Table / dataset references mirror run_automation.automationId: an UNSET
// reference is a soft warning (connect-it-later), an unresolved one is a
// warning in a draft and an ERROR at publish (when opts.knownTables /
// opts.knownDatasets are supplied).
function checkRef(id, path, ctx, { label, known, codeUnset, codeInvalid, codeMissing, codeUnverified }) {
    const { pushE, pushW } = ctx;
    if (id === null || id === undefined) {
        pushW({ code: codeUnset, severity: 'warning', path, message: `${label} has nothing selected yet.`, hint: 'Connect it before publishing.' });
        return;
    }
    if (typeof id !== 'string' || !id) {
        pushE({ code: codeInvalid, severity: 'error', path, message: `${label} must be a non-empty string id.`, hint: 'Reference an existing id.' });
        return;
    }
    if (known) {
        if (!known.has(id)) pushE({ code: codeMissing, severity: 'error', path, message: `${label} references unknown ${JSON.stringify(id)}.`, hint: 'Pick one the app owner has.' });
    } else {
        pushW({ code: codeUnverified, severity: 'warning', path, message: `${label} references ${JSON.stringify(id)} — not verified until publish.`, hint: 'Publishing checks it exists.' });
    }
}


function checkTableRef(tableId, path, ctx, label, codePrefix = 'binding') {
    // Data-model mode (opts.dataModel supplied): resolve the id against the
    // model's tables. The null/type handling stays with the legacy codes.
    if (ctx.dataTables && typeof tableId === 'string' && tableId) {
        if (!ctx.dataTables.has(tableId)) {
            const known = Array.from(ctx.dataTables.keys());
            const suggestion = pickClosestId(tableId, known);
            pushDataRef(ctx, {
                code: `${codePrefix}.unknown_table`, severity: 'error', path,
                message: `${label || 'Data reference'} references table ${JSON.stringify(tableId)} which does not exist in the app's data model.`,
                hint: suggestion ? `Did you mean "${suggestion}"?` : (known.length ? `Known table ids: ${known.join(', ')}.` : 'The app has no data tables yet — create the table first.'),
            });
        }
        return;
    }
    checkRef(tableId, path, ctx, {
        label: label || 'Data reference', known: ctx.knownTables,
        codeUnset: 'binding.table_unset', codeInvalid: 'binding.table_invalid',
        codeMissing: 'binding.table_missing', codeUnverified: 'binding.table_unverified',
    });
}

/**
 * The SECOND kind of table — alongside checkTableRef above, not instead of it.
 *
 * checkTableRef answers one question: "does the model know this table?". A model table can however
 * fetch its rows from a STUDIO DATATABLE (model.tables[].source = {kind:'datatable', datatableId,
 * mode}), and then there is a second reference that can come loose: the datatable itself. A table
 * without `source` owns its own storage and passes through here undisturbed — the existing kind
 * keeps working exactly as it worked.
 *
 * A datatableId that points nowhere is reported BY NAME. Silently skipping it yields an app that
 * validates, publishes, runs and shows an empty screen; that is noticed only when someone needs the
 * data, and then nothing says WHERE it went wrong.
 *
 * The ladder is the same as checkRef: without ctx.knownDatatables (the caller has no list) a WARNING
 * with the id in it — unknown, not silent —; with a list a hard error via pushDataRef. Guessing a
 * list is not allowed: a datatable may sit in the organisation scope while the owner sends only his
 * personal list, and then a working app would be rejected.
 *
 * The form of `source` belongs to the data model contract (dataModel/modelValidate.js) and is already
 * rejected there if it is wrong. Here it is NOT repaired again but it IS reported again: this path
 * receives a model from a caller, and a model that got past the contract gate without being
 * canonicalised may not yield a table that is silently read as "own storage".
 */
function checkTableSource(tableId, path, ctx, label, { codePrefix = 'binding' } = {}) {
    // Only in data-model mode, and only for an id that means something — a missing or broken tableId
    // is already reported by checkTableRef.
    if (!ctx.dataTableSources || typeof tableId !== 'string' || !tableId) return;
    const source = ctx.dataTableSources.get(tableId);
    if (source === undefined || source === null) return; // de bestaande soort

    // `path` remains EVERYWHERE the path of the reference itself (the binding, the step). The `source`
    // block sits in the data model, not in the definition, so '<binding>.source.datatableId' would be
    // a path that exists nowhere and that the editor cannot point to. What is broken is stated in the
    // message; where the author can repair it is stated in the path.
    const what = label || 'Data reference';
    const via = `via table ${JSON.stringify(tableId)}`;
    const bad = (message, hint) => pushDataRef(ctx, {
        code: `${codePrefix}.table_source_invalid`, severity: 'error', path, message, hint,
    });

    if (typeof source !== 'object' || Array.isArray(source)) {
        bad(`${what} reads a table (${via}) whose \`source\` is not an object.`, 'A linked table needs { kind: "datatable", datatableId, mode } — fix it in the Tables editor.');
        return;
    }
    if (!TABLE_SOURCE_KINDS.includes(source.kind)) {
        bad(
            `${what} reads a table (${via}) whose source kind ${JSON.stringify(source.kind)} is unknown.`,
            `Use one of: ${TABLE_SOURCE_KINDS.join(', ')} — or drop the link to keep the rows in the app itself.`,
        );
        return;
    }
    // Two values, and a third is an error. Reading it silently as 'read' would turn a typo ('readWrite')
    // into a permission that nobody has requested, and the author would see nowhere that their choice
    // was ignored.
    if (!TABLE_SOURCE_MODES.includes(source.mode)) {
        bad(
            `${what} reads a linked table (${via}) whose mode ${JSON.stringify(source.mode)} is not a mode.`,
            `Use ${TABLE_SOURCE_MODES.map((m) => JSON.stringify(m)).join(' or ')} — it is never guessed.`,
        );
    }
    if (typeof source.datatableId !== 'string' || !source.datatableId) {
        bad(
            `${what} reads a linked table (${via}) with no Studio table selected.`,
            'Pick the Studio table its rows come from.',
        );
        return;
    }
    if (ctx.knownDatatables) {
        if (!ctx.knownDatatables.has(source.datatableId)) {
            const known = Array.from(ctx.knownDatatables);
            const suggestion = pickClosestId(source.datatableId, known);
            pushDataRef(ctx, {
                code: `${codePrefix}.unknown_datatable`, severity: 'error', path,
                message: `${what} reads Studio table ${JSON.stringify(source.datatableId)} (${via}), which the app owner does not have.`,
                hint: suggestion ? `Did you mean "${suggestion}"?` : (known.length ? `Studio tables the owner has: ${known.join(', ')}.` : 'The owner has no Studio tables — create one, or keep the rows in the app itself.'),
            });
        }
        return;
    }
    ctx.pushW({
        code: `${codePrefix}.datatable_unverified`, severity: 'warning', path,
        message: `${what} reads Studio table ${JSON.stringify(source.datatableId)} (${via}) — not verified here.`,
        hint: 'Publishing checks the Studio table still exists and that the owner may read it.',
    });
}

/**
 * MAY this reference CHANGE rows? — the third question, alongside checkTableRef ("does the model know
 * this table") and checkTableSource ("does the link still exist").
 *
 * Until now `mode` fixed only the SHAPE: the data-model contract rejected a third value and that was
 * that. The rule itself — read means read — was enforced only at RUN time (appStudio/datatableSource.js).
 * Consequence: a create_record/update_record/delete_record step or an ai_extract writeTo on a read link
 * validated cleanly, published cleanly, and then failed with 403 on every click of a user. The author
 * should hear that at publication, not the user while filling in.
 *
 * This is NOT a cross-reference for which a list from outside is needed: the mode is in the model that
 * this call itself received. Hence a hard error via pushDataRef — demoted to a warning in a draft save
 * as with every other data-model finding, blocking at publication.
 *
 * An UNKNOWN mode counts here as not writable. Reading it as readwrite would turn a typo into a
 * permission; checkTableSource reports it separately as broken, so there is one message about the form
 * and one about the consequence.
 */
function checkTableWritable(tableId, path, ctx, label, { codePrefix = 'binding' } = {}) {
    if (!ctx.dataTableSources || typeof tableId !== 'string' || !tableId) return;
    const source = ctx.dataTableSources.get(tableId);
    if (source === undefined || source === null) return; // own storage: the app decides
    // A `source` that is not an object, or an unknown kind, has already been reported by
    // checkTableSource. Here only one thing counts: it is not writable.
    const mode = isObject(source) ? source.mode : null;
    if (mode === WRITABLE_TABLE_SOURCE_MODE) return;
    pushDataRef(ctx, {
        code: `${codePrefix}.table_read_only`, severity: 'error', path,
        message: `${label || 'This step'} changes rows in table ${JSON.stringify(tableId)}, which is linked to a Studio table for reading only.`,
        hint: `Set the link to ${JSON.stringify(WRITABLE_TABLE_SOURCE_MODE)} in the Tables editor, or write to a table the app owns.`,
    });
}

// Connector references mirror datasets: in data-model mode the id must resolve
// against model.connectors[]; without a model it is a soft "not verified until
// publish" warning. binding.unknown_connector is the hard publish-gate error.
function checkConnectorRef(connectorId, path, ctx, label) {
    const { pushE, pushW } = ctx;
    if (connectorId === null || connectorId === undefined) {
        pushW({ code: 'binding.connector_unset', severity: 'warning', path, message: `${label} has no connector selected yet.`, hint: 'Pick a connector before publishing.' });
        return;
    }
    if (typeof connectorId !== 'string' || !connectorId) {
        pushE({ code: 'binding.connector_invalid', severity: 'error', path, message: `${label} connectorId must be a non-empty string.`, hint: 'Reference a connector id from the data model.' });
        return;
    }
    if (ctx.dataConnectors) {
        if (!ctx.dataConnectors.has(connectorId)) {
            const known = Array.from(ctx.dataConnectors);
            const suggestion = pickClosestId(connectorId, known);
            pushDataRef(ctx, {
                code: 'binding.unknown_connector', severity: 'error', path,
                message: `${label} references connector ${JSON.stringify(connectorId)} which the app does not have.`,
                hint: suggestion ? `Did you mean "${suggestion}"?` : (known.length ? `Known connector ids: ${known.join(', ')}.` : 'The app has no connectors yet — add one in the Connectors tab first.'),
            });
        }
        return;
    }
    pushW({ code: 'binding.connector_unverified', severity: 'warning', path, message: `${label} references ${JSON.stringify(connectorId)} — not verified until publish.`, hint: 'Publishing checks the connector exists.' });
}

// Connector binding params: an object map { key: literal | {kind:'formula',expr} }.
// Formula params are parse-compiled (never executed); literals pass through and
// are sanitised again server-side before the connector runs.
function validateConnectorParams(params, path, ctx) {
    const { pushE } = ctx;
    if (!isObject(params)) {
        pushE({ code: 'binding.params_invalid', severity: 'error', path, message: 'connector params must be an object map of { key: literal | {kind:"formula",expr} }.', hint: 'Use { paramName: "literal" } or { paramName: {kind:"formula", expr:"vars.…"} }.' });
        return;
    }
    for (const [key, v] of Object.entries(params)) {
        const p = `${path}.${key}`;
        if (v === null) continue;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') continue;
        if (isObject(v) && v.kind === 'formula') { validateFormula(v.expr, `${p}.expr`, ctx, FORMULA_SCOPE_ROOTS); continue; }
        pushE({ code: 'binding.params_invalid', severity: 'error', path: p, message: `connector param "${key}" must be a literal (string/number/boolean) or {kind:"formula",expr}.`, hint: 'Wrap dynamic values as {kind:"formula", expr:"vars.…"}.' });
    }
}

function checkDatasetRef(datasetId, path, ctx, label) {
    // Reserved ids are answered by the platform, not by the app's dataset
    // table — so "the app does not have it" is the wrong question. The gate
    // that matters for these lives on the server route (the app must declare
    // model.directory.orgMembers) and in the app's own visibility.
    if (RESERVED_DATASET_IDS.includes(datasetId)) return;
    if (ctx.dataDatasets && typeof datasetId === 'string' && datasetId) {
        if (!ctx.dataDatasets.has(datasetId)) {
            const known = Array.from(ctx.dataDatasets);
            const suggestion = pickClosestId(datasetId, known);
            pushDataRef(ctx, {
                code: 'binding.unknown_dataset', severity: 'error', path,
                message: `${label || 'Dataset reference'} references dataset ${JSON.stringify(datasetId)} which the app does not have.`,
                hint: suggestion ? `Did you mean "${suggestion}"?` : (known.length ? `Known dataset ids: ${known.join(', ')}.` : 'The app has no datasets yet — create the dataset first.'),
            });
        }
        return;
    }
    checkRef(datasetId, path, ctx, {
        label: label || 'Dataset reference', known: ctx.knownDatasets,
        codeUnset: 'binding.dataset_unset', codeInvalid: 'binding.dataset_invalid',
        codeMissing: 'binding.dataset_missing', codeUnverified: 'binding.dataset_unverified',
    });
}

/**
 * Field-key resolution against the data model (data-model mode only; no-op
 * otherwise or when the table itself did not resolve — the unknown-table
 * record already covers that). `allowSystem` admits the five system columns
 * (filter/sort may address them; step writes may not).
 */
function checkFieldRef(tableId, fieldKey, path, ctx, label, { codePrefix = 'binding', allowSystem = true } = {}) {
    if (!ctx.dataTables || typeof tableId !== 'string' || !tableId) return;
    const fields = ctx.dataTables.get(tableId);
    if (!fields) return;
    // A table that fetches its rows from a Studio datatable does not own its column list: that is in the
    // datatable and can change there without this model noticing. What is in `fields` here is at most a
    // copy, and a copy that lags behind would reject a working binding. So do not judge it here — the
    // same consideration as with a dynamic groupBy in bindings.js: the server rejects the column if it
    // does not exist, with the real column list in hand.
    if (ctx.dataTableSources && ctx.dataTableSources.get(tableId)) return;
    if (typeof fieldKey !== 'string' || !fieldKey) return; // structural error reported by the caller
    if (fields.has(fieldKey)) return;
    if (SYSTEM_COLUMNS.includes(fieldKey)) {
        if (allowSystem) return;
        pushDataRef(ctx, {
            code: `${codePrefix}.unknown_field`, severity: 'error', path,
            message: `${label} writes system column ${JSON.stringify(fieldKey)} — system columns (${SYSTEM_COLUMNS.join(', ')}) are server-managed and cannot be written.`,
            hint: 'Remove the column; the server fills it automatically.',
        });
        return;
    }
    const suggestion = pickClosestId(fieldKey, Array.from(fields));
    pushDataRef(ctx, {
        code: `${codePrefix}.unknown_field`, severity: 'error', path,
        message: `${label} references field ${JSON.stringify(fieldKey)} which is not on table ${JSON.stringify(tableId)}.`,
        hint: suggestion ? `Did you mean "${suggestion}"?` : `Fields on the table: ${Array.from(fields).join(', ') || '(none)'}${allowSystem ? `; system columns (${SYSTEM_COLUMNS.join(', ')}) also resolve` : ''}.`,
    });
}

// run_automation reference (top-level and inside steps).
function checkAutomationRef(aid, path, ctx, label) {
    const { pushE, pushW, ownedAutomations } = ctx;
    if (aid === null || aid === undefined) {
        pushW({ code: 'action.automation_unset', severity: 'warning', path, message: `${label} has no automation selected yet.`, hint: "Pick one of the user's automations before publishing." });
        return;
    }
    if (typeof aid !== 'string') {
        pushE({ code: 'action.automation_invalid', severity: 'error', path, message: 'automationId must be a string or null.', hint: "Use the automation's id." });
        return;
    }
    if (ownedAutomations) {
        const rec = ownedAutomations.get(aid);
        if (!rec) pushE({ code: 'action.automation_missing', severity: 'error', path, message: `${label} references automation "${aid}" which the owner does not have.`, hint: 'Pick an automation the app owner owns.' });
        else if (!(rec === true || rec.isActive)) pushE({ code: 'action.automation_inactive', severity: 'error', path, message: `${label} references automation "${aid}" which is not active.`, hint: 'Activate the automation, then publish the app.' });
    }
}

// A modal reference must resolve to a `modal` component id in the tree.
function checkModalRef(modalId, path, ctx, label) {
    const { pushE, modalIds } = ctx;
    if (typeof modalId !== 'string' || !modalId) {
        pushE({ code: 'action.modal_missing', severity: 'error', path, message: `${label} needs a modalId.`, hint: 'Reference a modal component id.' });
        return;
    }
    if (!modalIds.has(modalId)) {
        const suggestion = pickClosestId(modalId, Array.from(modalIds));
        pushE({ code: 'action.modal_unresolved', severity: 'error', path, message: `${label} targets unknown modal ${JSON.stringify(modalId)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add a modal component with that id.' });
    }
}

// Navigate params — a bounded map of { key: {kind:'static',value} |
// {kind:'formula',expr} }. Keys must be formula-addressable identifiers
// (screen.params.<key>); formulas are parse-compiled (never executed) with
// roots restricted to FORMULA_SCOPE_ROOTS.
const NAV_PARAM_KEY_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,59}$/;

function validateNavigateParams(label, params, path, ctx) {
    const { pushE } = ctx;
    if (!isObject(params)) {
        pushE({ code: 'action.params_invalid', severity: 'error', path, message: `${label} \`params\` must be an object map.`, hint: 'Use { key: {kind:"static",value} | {kind:"formula",expr} }.' });
        return;
    }
    const keys = Object.keys(params);
    if (keys.length > LIMITS.MAX_NAVIGATE_PARAMS) {
        pushE({ code: 'action.params_too_many', severity: 'error', path, message: `${label} has ${keys.length} params — the maximum is ${LIMITS.MAX_NAVIGATE_PARAMS}.`, hint: 'Pass fewer navigation params.' });
        return;
    }
    for (const [key, entry] of Object.entries(params)) {
        const p = `${path}.${key}`;
        if (!NAV_PARAM_KEY_RE.test(key)) {
            pushE({ code: 'action.param_key_invalid', severity: 'error', path: p, message: `${label} param key ${JSON.stringify(key)} is not a legal identifier.`, hint: 'Keys must match [a-zA-Z_$][a-zA-Z0-9_$]* (max 60 chars) so screen.params.<key> is addressable.' });
            continue;
        }
        if (!isObject(entry) || (entry.kind !== 'static' && entry.kind !== 'formula')) {
            pushE({ code: 'action.param_kind_invalid', severity: 'error', path: p, message: `${label} param "${key}" must be {kind:'static',value} or {kind:'formula',expr}.`, hint: 'Wrap plain values as {kind:"static", value}.' });
            continue;
        }
        if (entry.kind === 'formula') validateFormula(entry.expr, `${p}.expr`, ctx, FORMULA_SCOPE_ROOTS);
    }
}

function validateInputMapping(actionId, mapping, path, ctx) {
    const { pushE, pushW, formIds, inputNamesByForm, allInputNames } = ctx;
    if (!isObject(mapping)) {
        pushE({ code: 'action.mapping_invalid', severity: 'error', path, message: 'inputMapping must be an object map of { param: mapping }.', hint: `Each value is {kind:'static', value} or {kind:'field', name, formId?}.` });
        return;
    }
    for (const [param, m] of Object.entries(mapping)) {
        const p = `${path}.${param}`;
        if (!isObject(m) || !INPUT_MAPPING_KINDS.includes(m.kind)) {
            pushE({ code: 'action.mapping_kind_invalid', severity: 'error', path: p, message: `Mapping for "${param}" has invalid kind ${JSON.stringify(isObject(m) ? m.kind : m)}.`, hint: `Use one of: ${INPUT_MAPPING_KINDS.join(', ')}.` });
            continue;
        }
        if (m.kind !== 'field') continue;
        if (typeof m.name !== 'string' || !m.name) {
            pushE({ code: 'action.mapping_name_missing', severity: 'error', path: p, message: `Field mapping for "${param}" needs a \`name\`.`, hint: 'Use the props.name of an input component.' });
            continue;
        }
        // Name resolution is a WARNING (mirrors automation ref-warnings): the
        // runtime submits undefined for a missing field, it never crashes.
        let names = allInputNames;
        if (m.formId !== undefined && m.formId !== null) {
            if (typeof m.formId !== 'string' || !formIds.has(m.formId)) {
                pushW({ code: 'action.mapping_form_unknown', severity: 'warning', path: `${p}.formId`, message: `Mapping for "${param}" targets unknown form ${JSON.stringify(m.formId)}.`, hint: formIds.size ? `Known form ids: ${Array.from(formIds).join(', ')}.` : 'The app has no forms yet.' });
            } else {
                names = inputNamesByForm.get(m.formId) || new Set();
            }
        }
        if (!names.has(m.name)) {
            const suggestion = pickClosestId(m.name, Array.from(names));
            pushW({ code: 'action.mapping_field_unknown', severity: 'warning', path: `${p}.name`, message: `Mapping for "${param}" reads input "${m.name}" which no input component provides — it will submit undefined.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add an input with that props.name, or fix the mapping.' });
        }
    }
}

module.exports = {
    pushDataRef,
    checkTableRef,
    checkTableSource,
    checkTableWritable,
    checkConnectorRef,
    validateConnectorParams,
    checkDatasetRef,
    checkFieldRef,
    checkAutomationRef,
    checkModalRef,
    validateNavigateParams,
    validateInputMapping,
};
