/**
 * App Studio — action sequence walking, in ONE place.
 *
 * A v2 action is { kind:'sequence', steps:[Step] }; a bare v1 action is an
 * implicit 1-step sequence. flattenSteps walks the tree in PRE-ORDER (a step,
 * then its child branches in a FIXED order) assigning each a stable ordinal.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED: the browser coordinator
 * (agent-hub runtime/useActionRunner.js) performs the byte-identical walk and
 * posts only a `stepIndex`; the server re-resolves the step from its own copy
 * of the definition and never trusts a client-supplied body. Two server-side
 * copies of the walk — one for the authenticated route, one for the public one
 * — is two ways for that index to mean two different steps, which is a step
 * executing that the caller never asked for.
 */

'use strict';

const { MAX_FIELD_KEY_LEN, MAX_INPUT_FIELDS } = require('./actionExecutor');

function normalizeSequence(action) {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps : [];
    return [action]; // bare v1 action → 1-step sequence
}

function flattenSteps(steps, out = []) {
    for (const step of (Array.isArray(steps) ? steps : [])) {
        if (!step || typeof step !== 'object') continue;
        out.push(step);
        if (step.kind === 'condition') {
            flattenSteps(step.then, out);
            flattenSteps(step.else, out);
        } else if (step.kind === 'loop') {
            flattenSteps(step.steps, out);
        } else if (step.kind === 'switch') {
            for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
                if (c && typeof c === 'object') flattenSteps(c.steps, out);
            }
            flattenSteps(step.default, out);
        }
    }
    return out;
}

/**
 * Hygiene on client-supplied form/var bags: a plain object, capped field count
 * and key length. The 64KB body guard already bounds total size; this bounds
 * fan-out. Values pass through as-is (multiselect arrays / file descriptors are
 * legal record values — the query compiler validates + coerces per field).
 */
function sanitizeBag(bag) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(bag)) {
        if (count >= MAX_INPUT_FIELDS) break;
        if (typeof k !== 'string' || k.length > MAX_FIELD_KEY_LEN) continue;
        out[k] = v;
        count++;
    }
    return out;
}

module.exports = { normalizeSequence, flattenSteps, sanitizeBag };
