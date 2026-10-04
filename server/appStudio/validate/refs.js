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
const { isObject } = require('./shared');
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

// Data-reference finding — an error normally (publish), demoted to a warning
// when the caller opted in via opts.dataRefsAsWarnings (human draft saves).
function pushDataRef(ctx, rec) {
    if (ctx.dataRefsAsWarnings) ctx.pushW({ ...rec, severity: 'warning' });
    else ctx.pushE(rec);
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
 * De TWEEDE tabelsoort — naast checkTableRef hierboven, niet in plaats daarvan.
 *
 * checkTableRef beantwoordt één vraag: "kent het model deze tabel?". Een
 * modeltabel kan haar rijen echter uit een STUDIO-DATATABEL halen
 * (model.tables[].source = {kind:'datatable', datatableId, mode}), en dan is er
 * een tweede verwijzing die los kan raken: de datatabel zelf. Een tabel zonder
 * `source` bezit haar eigen opslag en gaat hier ongemoeid door — de bestaande
 * soort blijft precies werken zoals hij werkte.
 *
 * Een datatableId die nergens naar wijst wordt BIJ NAAM gemeld. Stil overslaan
 * levert een app op die valideert, publiceert, draait en een leeg scherm laat
 * zien; dat wordt pas opgemerkt als iemand de gegevens nodig heeft, en dan is
 * er niets dat vertelt wáár het misging.
 *
 * De ladder is dezelfde als checkRef: zonder ctx.knownDatatables (de aanroeper
 * heeft geen lijst) een WAARSCHUWING met de id erin — onbekend, niet stil —;
 * mét een lijst een harde fout via pushDataRef. Een lijst raden mag niet: een
 * datatabel kan in de organisatie-scope staan terwijl de eigenaar alleen zijn
 * persoonlijke lijst meestuurt, en dan zou een werkende app worden afgekeurd.
 *
 * De vorm van `source` hoort bij het datamodel-contract (dataModel/
 * modelValidate.js) en is daar al afgewezen als hij niet klopt. Hier wordt hij
 * NIET nog eens gerepareerd maar wel nog eens gemeld: dit pad krijgt het model
 * van een aanroeper, en een model dat langs de contractpoort is gekomen zonder
 * gecanonicaliseerd te zijn mag geen tabel opleveren die stilzwijgend als
 * "eigen opslag" wordt gelezen.
 */
function checkTableSource(tableId, path, ctx, label, { codePrefix = 'binding' } = {}) {
    // Alleen in datamodel-modus, en alleen voor een id dat ergens op slaat —
    // een ontbrekende of kapotte tableId is al door checkTableRef gemeld.
    if (!ctx.dataTableSources || typeof tableId !== 'string' || !tableId) return;
    const source = ctx.dataTableSources.get(tableId);
    if (source === undefined || source === null) return; // de bestaande soort

    // `path` blijft OVERAL het pad van de verwijzing zelf (de binding, de stap).
    // Het `source`-blok staat in het datamodel, niet in de definitie, dus
    // '<binding>.source.datatableId' zou een pad zijn dat nergens bestaat en dat
    // de editor niet kan aanwijzen. Wat er kapot is, staat in het bericht; waar
    // de auteur het kan repareren, staat in het pad.
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
    // Twee waarden, en een derde is een fout. Hem hier stil als 'read' lezen zou
    // een typefout ('readWrite') veranderen in een recht dat niemand heeft
    // aangevraagd, en de auteur zou nergens zien dat zijn keuze is genegeerd.
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
 * MAG deze verwijzing rijen VERANDEREN? — de derde vraag, naast checkTableRef
 * ("kent het model deze tabel") en checkTableSource ("bestaat de koppeling nog").
 *
 * `mode` legde tot nu toe alleen de VORM vast: het datamodel-contract keurde een
 * derde waarde af en daar bleef het bij. De regel zelf — read betekent lezen —
 * werd pas bij het DRAAIEN afgedwongen (appStudio/datatableSource.js). Gevolg:
 * een create_record/update_record/delete_record-stap of een ai_extract-writeTo
 * op een read-koppeling valideerde schoon, publiceerde schoon, en faalde daarna
 * bij elke klik van een gebruiker met 403. De auteur hoort dat bij het
 * publiceren te horen, niet de gebruiker bij het invullen.
 *
 * Dit is GEEN kruisverwijzing waarvoor een lijst van buiten nodig is: de mode
 * staat in het model dat deze aanroep zelf heeft meegekregen. Vandaar een harde
 * fout langs pushDataRef — in een draftsave gedemoteerd zoals elke andere
 * datamodel-bevinding, bij publiceren blokkerend.
 *
 * Een ONBEKENDE mode telt hier als niet-schrijfbaar. Hem als readwrite lezen zou
 * een typefout in een recht veranderen; checkTableSource meldt hem apart als
 * kapot, dus er staat dan één bericht over de vorm en één over het gevolg.
 */
function checkTableWritable(tableId, path, ctx, label, { codePrefix = 'binding' } = {}) {
    if (!ctx.dataTableSources || typeof tableId !== 'string' || !tableId) return;
    const source = ctx.dataTableSources.get(tableId);
    if (source === undefined || source === null) return; // eigen opslag: de app beslist
    // Een `source` die geen object is, of een onbekende kind, is al gemeld door
    // checkTableSource. Hier telt alleen: hij is niet schrijfbaar.
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
    // Een tabel die haar rijen uit een Studio-datatabel haalt, bezit haar
    // kolomlijst niet: die staat in de datatabel en kan daar veranderen zonder
    // dat dit model iets merkt. Wat hier in `fields` staat is hooguit een kopie,
    // en een kopie die achterloopt zou een werkende binding afkeuren. Dus niet
    // hier beoordelen — dezelfde afweging als bij een dynamische groupBy in
    // bindings.js: de server keurt de kolom af als hij niet bestaat, met de
    // echte kolomlijst in de hand.
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
