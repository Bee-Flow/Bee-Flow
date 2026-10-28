/**
 * builder_update_step(s) — patch existing steps in place (same id, wiring
 * preserved): the orchestration of the patch guards, the scalar pass and the
 * derived fields, plus the all-or-nothing batch. Moved out of stepEditing.js;
 * the per-type guards live in patchGuards/, the allow-list in patchFields.js.
 */
// @typecheck
const crypto = require('crypto');
const { isSideEffect } = require('../../sideEffectMap');
const { listStepIds, findStepAnywhere } = require('../draftGraph');
const { sanitizeForEach, checkTextPlaceholders, checkLoopBindings, sanitizeArrayRef } = require('../bindings');
// The leaf builders, not the stepBuilders index: the index, aiStep,
// inspection and documentDiscovery sit in the server's largest import cycle,
// their names come through cycleDeps (filled by the stepEditing.js barrel).
const { sanitizeParseJsonFieldRows, sanitizeSetOperations } = require('../stepBuilders/dataSteps');
const { sanitizeDatatableCursor } = require('../stepBuilders/datatableStep');
const { translateDataExtractionVocabulary } = require('../stepBuilders/dataExtractionStep');
const { unknownToolError } = require('../stepBuilders/toolResolution');
const cycleDeps = require('./cycleDeps');
const { patchFlatten } = require('../stepBuilders/flattenStep');
const { normalizeQuery: normalizeHttpQuery } = require('../../../core/automationRunner/httpQuery');
const { followAddedSteps, followPatchedRoute } = require('../routeFollowDraft');
const {
    FLATTEN_PLANNED_KEYS, TEXT_TEMPLATE_FIELDS, PATCHABLE_FIELDS, ROUTE_SHAPE_KEYS,
} = require('./patchFields');
const { normalizePatchField } = require('./normalizePatchField');
const { typeChangeFromPatch, specForTypeChange, typeChangeHint } = require('./typeChange');
const { applyReplaceStep } = require('./replaceStep');
const { applyPositionPatch } = require('./patchGuards/position');
const { translateDatatablePatch, linkDatatablePatch, patchDatatableBody } = require('./patchGuards/datatable');
const { fillOnlyRefusal } = require('./patchGuards/fillOnly');
const { patchDataExtraction } = require('./patchGuards/dataExtraction');
const { patchBindingMap } = require('./patchGuards/bindings');
const { patchTableStep } = require('./patchGuards/tables');

/** Run a type change patch as the replace it is. */
function updateAsTypeChange(graph, step, found, patch, newType, args, draftWrap) {
    if (found.kind === 'loop') {
        return {
            error: `"${step.id}" sits inside a loop body, and no tool changes the type of a loop-body step in place. Remove it and add the new step inside the loop body, or re-send the whole loop with builder_replace_step({stepId:"${found.parentLoop && found.parentLoop.id}", newType:"loop", spec:{overRef, itemVar, maxIterations, body:[…]}}).`,
            _fixHint: 'Reject reason: type change inside a loop body. Rebuild the loop body (builder_replace_step on the loop) instead of changing one body step\'s type.',
        };
    }
    const { spec, notes } = specForTypeChange(step, patch, newType);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- aboutTable below is a fixed alternation of literals over our own error text
    const r = applyReplaceStep(graph, { stepId: step.id, newType, spec }, { draft: draftWrap && draftWrap.def, scope: args.scope || null }, draftWrap);
    if (r.error) {
        // A consent question or an access refusal keeps its own instructions.
        if (r._askArgs) return r;
        // A refusal about the table itself (missing, unknown) is exactly what
        // the type-change hint answers; any other keeps its own, precise hint
        // (an unknown column, a read-only table) with the type-change form
        // appended.
        const aboutTable = /datatableId|no datatable|unknown datatable|datatable exists/i.test(`${r.error} ${r._fixHint || ''}`);
        const hint = typeChangeHint(step.id, newType, draftWrap);
        return { ...r, _fixHint: r._fixHint && !aboutTable ? `${r._fixHint} (A type change is sent as: ${hint.replace(/^Reject reason: type change\. /, '')})` : hint };
    }
    return {
        updated: r.replaced,
        replacedType: { from: step.type, to: newType },
        ...(r.rewired ? { rewired: r.rewired } : {}),
        _warnings: [
            ...(r._warnings || []), ...notes,
            `builder_update_step does not change a step's type, so this patch was applied as builder_replace_step(newType:"${newType}"): same id, same wiring.`,
        ],
    };
}

/**
 * builder_update_step — patch an existing step in place (same type, same id,
 * wiring preserved). Reuses validateAndFixBindings / sanitizeForEach so the
 * patched step is identical to a freshly-added one.
 */
function applyUpdateStep(graph, args, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    let patch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
    if (!patch) return { error: 'patch must be an object of fields to change.' };
    if ('id' in patch) return { error: 'Cannot change a step id.' };

    let found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    let step = found.step;
    // Before the move and the allow-list: a type-change patch carries fields
    // of the NEW type, which the old type's allow-list would refuse by name.
    const change = typeChangeFromPatch(step, patch, draftWrap);
    if (change && change.error) return change;
    if (change) return updateAsTypeChange(graph, step, found, patch, change.newType, args, draftWrap);
    if ('type' in patch) {
        // Same type restated: nothing to change, and not a field to store.
        patch = { ...patch };
        delete patch.type;
    }
    if (step.type === 'fill_document' && ['documentId','documentVersionId','values','sectionOverrides'].some(k=>k in patch)) {
        const candidate = {...step,...patch};
        const issue = cycleDeps.documentDiscovery().inspectBindings(candidate,draftWrap,'builder');
        if (issue) return issue;
        patch = {...patch,documentVersionId:candidate.documentVersionId};
    }

    // Position and branch wiring: see patchGuards/position.js.
    const position = applyPositionPatch(graph, stepId, step, patch);
    if (position.error) return { error: position.error };
    if (position.result) return position.result;
    const { moved } = position;
    patch = position.patch;
    if (position.found) {
        // The move re-ordered the steps array, so the slot found above is stale.
        found = position.found;
        step = found.step;
    }

    // A data_extraction patch in integration_action / ai_step vocabulary
    // ({inputs:{source}}, {prompt}, {outputSchema}) is translated the way the
    // add path translates it — refusing "inputs not patchable" here would
    // send the model to remove + re-add the step, minting a new id.
    const patchNotes = [];
    if (step.type === 'data_extraction') {
        const tr = translateDataExtractionVocabulary(patch);
        patch = tr.args;
        patchNotes.push(...tr.notes);
    }
    // The datatable mirror: {fields:{…}} / {row:{…}} / {tableId} / {op:"append"}
    // are the add path's foreign vocabulary, and "fields not patchable on a
    // datatable step" sent the model to remove + re-add. Translated BEFORE
    // the allow-list, so the check sees the step's own field names. The op
    // is resolved with hasValues:true: a patch that blanks the op of a step
    // is not asking for the harmless default, it is a mistake to refuse.
    const translated = translateDatatablePatch(step, patch, patchNotes);
    if (translated.refusal) return translated.refusal;
    patch = translated.patch;

    const allowed = PATCHABLE_FIELDS[step.type];
    if (!allowed) return { error: `Step type "${step.type}" cannot be patched.` };
    const bad = Object.keys(patch).filter(k => !allowed.includes(k));
    if (bad.length) {
        // A loop's body is the one refusal that used to be a dead end: no tool
        // appends into an existing body, `scope` only resolves flowlet keys, and
        // this message named neither escape. A model that reads it literally
        // concludes it must remove and re-add the loop — which mints a new id
        // and breaks every downstream ref. Name the way out instead.
        if (step.type === 'loop' && (bad.includes('body') || bad.includes('steps'))) {
            return { error: `A loop's body is not patched field-by-field. Re-send the whole body with builder_replace_step({stepId:"${stepId}", newType:"loop", spec:{overRef, itemVar, maxIterations, body:[…]}}) — that KEEPS the loop's id and all its wiring, so downstream refs survive. Body steps are FLAT step objects; to change ONE of them, patch it by its own id. Patchable on the loop itself: ${allowed.join(', ')}.` };
        }
        return { error: `Field(s) ${bad.join(', ')} not patchable on a ${step.type} step. Allowed: ${allowed.join(', ')}.` };
    }

    // §B3 gate: re-pointing an integration_action at a new tool re-arms inspect.
    // The availability guard runs FIRST and for the same reason it exists on the
    // add path: a patch is otherwise a way to smuggle in a tool name the user
    // cannot run, on a step that was legitimate when it was created.
    if (step.type === 'integration_action' && 'tool' in patch) {
        const unknown = unknownToolError(patch.tool, draftWrap);
        if (unknown) return unknown;
        const mergedInputs = ('inputs' in patch) ? { ...(step.inputs || {}), ...(patch.inputs || {}) } : (step.inputs || {});
        const gate = cycleDeps.inspectGateError(patch.tool, mergedInputs, draftWrap);
        if (gate) return gate;
    }
    // ai_step modelTier must stay within the user's configured tier set.
    if (step.type === 'ai_step' && 'modelTier' in patch) {
        const tierErr = cycleDeps.modelTierGateError(patch.modelTier, draftWrap);
        if (tierErr) return tierErr;
    }
    // FILL-ONLY table link: see patchGuards/datatable.js.
    const link = linkDatatablePatch(stepId, step, patch, draftWrap, patchNotes);
    if (link.refusal) return link.refusal;
    const { filledTable } = link;
    // FILL-ONLY agent and knowledge base: see patchGuards/fillOnly.js.
    const fillOnly = fillOnlyRefusal(stepId, step, found, patch);
    if (fillOnly) return fillOnly;

    const next = { ...step };

    // parse_json.fields is an ARRAY of {name, path, ...} rows — not a binding
    // map — so it bypasses the bindKey machinery below (which would silently
    // drop it): replace wholesale through the same sanitizer as the add tool.
    if (step.type === 'parse_json' && 'fields' in patch) {
        const { fields, error } = sanitizeParseJsonFieldRows(patch.fields);
        if (error) return { error };
        next.fields = fields;
    }

    // data_extraction fields / source: see patchGuards/dataExtraction.js.
    const extraction = patchDataExtraction(graph, step, patch, next, draftWrap, patchNotes);
    if (extraction) return extraction;

    // read_table / table: source and ops, see patchGuards/tables.js.
    const tables = patchTableStep(graph, step, patch, next, draftWrap, patchNotes);
    if (tables) return tables;

    // set.operations is likewise an ARRAY — replace wholesale through the add
    // tool's sanitizer; null clears it.
    if (step.type === 'set' && 'operations' in patch) {
        if (patch.operations === null) { delete next.operations; }
        else {
            const { operations, error } = sanitizeSetOperations(patch.operations);
            if (error) return { error };
            if (operations.length) next.operations = operations; else delete next.operations;
        }
    }

    // A datatable's values / where / sort / cursor: see patchGuards/datatable.js.
    const datatable = patchDatatableBody(graph, step, patch, next, { filledTable, draftWrap, inputsMode: args.inputsMode, patchNotes });
    if (datatable) return datatable;

    // inputs / fields: merge-by-key (null deletes) unless inputsMode:'replace'
    // (patchGuards/bindings.js).
    // The forEach the step will have once this patch lands (an invalid one is
    // refused by the forEach block below): loop.<var> paths the patch sends
    // are checked against what it iterates.
    const feAfter = 'forEach' in patch
        ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
        : step.forEach;
    const bindings = patchBindingMap(graph, step, patch, next, { feAfter, draftWrap, inputsMode: args.inputsMode, patchNotes });
    if (bindings) return bindings;

    // forEach: re-validate; null clears it.
    if ('forEach' in patch) {
        if (patch.forEach === null) { delete next.forEach; }
        else {
            const { forEach, error, notes } = sanitizeForEach(patch.forEach, graph, draftWrap);
            if (error) return { error };
            if (forEach) next.forEach = forEach; else delete next.forEach;
            patchNotes.push(...(notes || []));
        }
    }

    // Text fields the run interpolates, and the list a step works through:
    // the same path checks the add tools run (bindings.js). The checked
    // values replace the patch's own in the scalar pass below (the patch
    // object is the model's and is never mutated).
    const checked = {};
    for (const key of TEXT_TEMPLATE_FIELDS[step.type] || []) {
        if (!(key in patch) || typeof patch[key] !== 'string') continue;
        const t = checkTextPlaceholders(patch[key], graph, { draftWrap, label: key });
        if (t.error) return { error: t.error };
        const loop = checkLoopBindings(t.text, graph, feAfter, draftWrap, { label: key });
        if (loop.error) return { error: loop.error };
        checked[key] = loop.value;
        patchNotes.push(...t.notes, ...loop.notes);
    }
    if (step.type === 'http_request' && ('query' in patch || ('url' in patch && typeof patch.url === 'string'))) {
        // The patch's url (already checked above) and query: a nested query left
        // in the URL moves into `query`; the query's own {{…}} paths get checked.
        const { checkQueryPlaceholders, liftUrlQuery } = require('../stepBuilders/outboundSteps');
        const urlNow = 'url' in checked ? checked.url : (typeof patch.url === 'string' ? patch.url : step.url);
        const queryNow = 'query' in patch ? normalizeHttpQuery(patch.query) : step.query;
        const lifted = liftUrlQuery(urlNow, queryNow);
        const qc = checkQueryPlaceholders(lifted.query, graph, draftWrap, feAfter);
        if (qc.error) return { error: qc.error };
        if ('url' in patch || lifted.url !== urlNow) checked.url = lifted.url;
        checked.query = qc.query;
        if (lifted.url !== urlNow && !('url' in patch)) patch = { ...patch, url: lifted.url };
        if (!('query' in patch) && qc.query) patch = { ...patch, query: qc.query };
        patchNotes.push(...lifted.notes, ...qc.notes);
    }
    const listKey = step.type === 'loop' ? 'overRef' : 'arrayRef';
    if (listKey in patch && typeof patch[listKey] === 'string' && patch[listKey].trim()) {
        const ar = sanitizeArrayRef(patch[listKey], graph, { draftWrap, strictRoot: step.type === 'set' });
        if (ar.error) return { error: ar.error.replace(/^arrayRef/, listKey) };
        checked[listKey] = ar.arrayRef;
        patchNotes.push(...ar.notes.map(n => n.replace(/^arrayRef/, listKey)));
    }
    if (step.type === 'datatable' && 'cursor' in patch) {
        const c = sanitizeDatatableCursor(patch.cursor, graph, draftWrap);
        if (c.error) return { error: c.error };
        checked.cursor = c.cursor;
        patchNotes.push(...c.notes);
    }

    // Scalar / structured fields.
    for (const k of allowed) {
        if (k === 'inputs' || k === 'fields' || k === 'forEach') continue;
        if (step.type === 'set' && k === 'operations') continue; // handled wholesale above
        if (step.type === 'datatable' && (k === 'values' || k === 'where')) continue; // canonicalized above
        if (step.type === 'data_extraction' && k === 'source') continue; // canonicalized above
        if (step.type === 'flatten' && FLATTEN_PLANNED_KEYS.includes(k)) continue; // patchFlatten below
        if ((step.type === 'read_table' || step.type === 'table') && (k === 'source' || k === 'ops')) continue; // patchTableStep above
        if (!(k in patch)) continue;
        const norm = normalizePatchField(step.type, k, k in checked ? checked[k] : patch[k]);
        if (norm === undefined) { if (k !== 'label') delete next[k]; }
        else next[k] = norm;
    }

    if (step.type === 'flatten') {
        const err = patchFlatten(graph, next, { ...patch, ...('arrayRef' in checked ? { arrayRef: checked.arrayRef } : {}) }, draftWrap);
        if (err) return { error: err };
    }

    // set cross-field integrity after the patch lands — the validator would
    // also catch these on save, but failing HERE gives the model an
    // actionable error on the very turn it made the mistake.
    if (step.type === 'set') {
        const listMode = typeof next.arrayRef === 'string';
        if (listMode && next.forEach) return { error: 'arrayRef (list mode) and forEach cannot be combined — list mode already applies the fields to every row. Clear forEach (forEach: null) or the arrayRef.' };
        if (!listMode && Array.isArray(next.operations) && next.operations.length) {
            return { error: 'operations need arrayRef — set arrayRef to an upstream list, or clear the operations (operations: null).' };
        }
        if (!listMode) delete next.maxItems;
    }

    // Derived fields the apply* builders compute.
    if (step.type === 'code' && 'code' in patch) {
        next.codeHash = crypto.createHash('sha256').update(next.code || '').digest('hex');
    }
    if (step.type === 'integration_action' && 'tool' in patch) {
        next.sideEffect = isSideEffect(next.tool);
        if (!('label' in patch) && (step.label === step.tool)) next.label = next.tool; // keep auto-label tracking the tool
    }

    found.container[found.index] = next;
    // R2, the agent-less half. `normalizePatchField` rebuilds agentPermissions
    // from its three names whenever the patch mentions it, and the add path no
    // longer writes the block at all without an agent — so re-apply the same
    // rule here, or a patched step ends up in a shape the add path cannot
    // produce and carries the orphan warning the add path stopped causing.
    // Covers the repair too: patching agentId to null on a bound step takes
    // the permissions with it, which is what "no agent" means.
    if (next.type === 'ai_step') {
        const hasSkills = Array.isArray(next.skillIds) && next.skillIds.length > 0;
        const block = cycleDeps.agentPermissionsBlock(next.agentPermissions, next.agentId, { hasSkills });
        if (block.error) return block;
        if (block.permissions === undefined) delete next.agentPermissions;
        else next.agentPermissions = block.permissions;
        // Same shape as the add path: only on a step with an agent, and only
        // when the list says something.
        if (!next.agentId || !Array.isArray(next.disabledAgentSkillIds) || next.disabledAgentSkillIds.length === 0) {
            delete next.disabledAgentSkillIds;
        }
    }

    // Follow the route (W8): a moved step reads the output it now hangs off;
    // a Condition whose outputs or list changed takes its readers along.
    if (found.kind === 'graph') {
        if (moved.length) patchNotes.push(...followAddedSteps(graph, [stepId]));
        if (ROUTE_SHAPE_KEYS.some(k => k in patch)) patchNotes.push(...followPatchedRoute(graph, step, stepId));
    }
    const updated = found.kind === 'graph' ? findStepAnywhere(graph, stepId).step : next;
    return { updated, ...(moved.length ? { moved } : {}), ...(patchNotes.length ? { _warnings: patchNotes } : {}) };
}

/**
 * builder_update_steps — batch, all-or-nothing (snapshot + rollback).
 *
 * Reports which steps actually CHANGED. A patch that re-states what the step
 * already says is not an error, but answering a bare "updated" to it is how a
 * model gets stuck: one turn re-sent the identical patch fifteen times, each
 * time read "updated", and burned the whole iteration budget on a no-op
 * (2026-09-12). `unchanged` plus a note is the signal to move on.
 */
function applyUpdateSteps(graph, args, draftWrap) {
    const updates = Array.isArray(args.updates) ? args.updates : null;
    if (!updates || !updates.length) return { error: 'updates must be a non-empty array of { stepId, patch }.' };
    const snapSteps = structuredClone(graph.steps);
    const snapEdges = structuredClone(graph.edges);
    const applied = [];
    const unchanged = [];
    // Each entry's notes (repaired paths, re-pointed readers) ride along, as
    // they do on a single builder_update_step.
    /** @type {string[]} */
    const warnings = [];
    for (const u of updates) {
        const before = JSON.stringify(findStepAnywhere(graph, (u && u.stepId) || '')?.step ?? null);
        const r = applyUpdateStep(graph, u || {}, draftWrap);
        if (r.error) {
            graph.steps = snapSteps;
            graph.edges = snapEdges;
            // The entry's own instructions travel with it: a consent question
            // (_askArgs) or the type-change form (_fixHint) is how the model
            // fixes this entry.
            return {
                error: `update for "${u && u.stepId}": ${r.error}`, _rolledBack: true,
                ...(r._askArgs ? { code: r.code, _askArgs: r._askArgs } : {}),
                ...(r._fixHint ? { _fixHint: r._fixHint } : {}),
            };
        }
        for (const w of r._warnings || []) warnings.push(`${r.updated.id}: ${w}`);
        const after = JSON.stringify(findStepAnywhere(graph, r.updated.id)?.step ?? null);
        // A move re-wires edges without touching the step object, so it counts
        // as a change even when the step itself is byte-identical.
        if (before !== null && before === after && !r.moved) unchanged.push(r.updated.id);
        else applied.push(r.updated.id);
    }
    if (!applied.length && unchanged.length) {
        return {
            updated: [],
            unchanged,
            _hint: `Nothing changed: ${unchanged.join(', ')} already had exactly these values. `
                + 'Re-sending the same patch will not help — inspect the step, change something else, or move on.',
        };
    }
    const out = unchanged.length ? { updated: applied, unchanged } : { updated: applied };
    return warnings.length ? { ...out, _warnings: warnings } : out;
}

module.exports = { applyUpdateStep, applyUpdateSteps };

/** @typedef {import('../pendingDatatables').DraftWrap} DraftWrap */

/** @typedef {import('../draftGraph').DraftGraph} DraftGraph */
