/**
 * builder_update_step(s) — patch existing steps in place (same id, wiring
 * preserved): the lookup and the type-change detour here, the passes the
 * patch goes through in updatePhases.mts, plus the all-or-nothing batch. The
 * per-type guards live in patchGuards/, the allow-list in patchFields.js.
 */
// @typecheck
const { listStepIds, findStepAnywhere } = require('../draftGraph');
const { typeChangeFromPatch, specForTypeChange, typeChangeHint } = require('./typeChange');
const { applyReplaceStep } = require('./replaceStep');
const { newUpdateState, fillDocumentPatch, UPDATE_PASSES, finishUpdate } = require('./updatePhases.mts');

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
 * The checks before any pass: the arguments, the step, a type change (applied
 * as the replace it is) and a fill_document's document. Answers `{ done }` to
 * stop with that result, or `{ state }` for the passes.
 */
function startUpdate(graph, args, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { done: { error: 'stepId is required.' } };
    let patch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
    if (!patch) return { done: { error: 'patch must be an object of fields to change.' } };
    if ('id' in patch) return { done: { error: 'Cannot change a step id.' } };

    const found = findStepAnywhere(graph, stepId);
    if (!found) return { done: { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` } };
    const step = found.step;
    // Before the move and the allow-list: a type-change patch carries fields
    // of the NEW type, which the old type's allow-list would refuse by name.
    const change = typeChangeFromPatch(step, patch, draftWrap);
    if (change && change.error) return { done: change };
    if (change) return { done: updateAsTypeChange(graph, step, found, patch, change.newType, args, draftWrap) };
    if ('type' in patch) {
        // Same type restated: nothing to change, and not a field to store.
        patch = { ...patch };
        delete patch.type;
    }
    const doc = fillDocumentPatch(step, patch, draftWrap);
    if (doc.issue) return { done: doc.issue };
    return { state: newUpdateState({ graph, args, draftWrap, stepId, found, patch: doc.patch }) };
}

/**
 * builder_update_step — patch an existing step in place (same type, same id,
 * wiring preserved). Reuses validateAndFixBindings / sanitizeForEach so the
 * patched step is identical to a freshly-added one.
 */
function applyUpdateStep(graph, args, draftWrap) {
    const start = startUpdate(graph, args, draftWrap);
    if (!start.state) return start.done;
    for (const pass of UPDATE_PASSES) {
        const answer = pass(start.state);
        if (answer) return answer;
    }
    return finishUpdate(start.state);
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
