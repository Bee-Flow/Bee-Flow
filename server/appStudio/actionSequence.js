// @typecheck strict
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
const { LIMITS } = require('./componentSpecs/limits');

/**
 * @param {import('./actionExecutor/shared').StepDef | null | undefined} action
 * @returns {import('./actionExecutor/shared').StepDef[]}
 */
function normalizeSequence(action) {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps : [];
    return [action]; // bare v1 action → 1-step sequence
}

/**
 * @param {import('./actionExecutor/shared').StepDef[] | null | undefined} steps
 * @param {import('./actionExecutor/shared').StepDef[]} [out]
 * @returns {import('./actionExecutor/shared').StepDef[]}
 */
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
 *
 * @param {Record<string, unknown> | null | undefined} bag
 * @returns {Record<string, unknown>}
 */
function sanitizeBag(bag) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
    /** @type {Record<string, unknown>} */
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

/**
 * @param {unknown} actions
 * @param {unknown} id
 * @returns {import('./actionExecutor/shared').StepDef | null}
 */
function ownActionOf(actions, id) {
    if (!actions || typeof actions !== 'object' || typeof id !== 'string' || !id) return null;
    if (!Object.hasOwn(actions, id)) return null;
    const a = /** @type {Record<string, unknown>} */ (actions)[id];
    return a && typeof a === 'object' && !Array.isArray(a) ? /** @type {import('./actionExecutor/shared').StepDef} */ (a) : null;
}

/**
 * The step a /step request names, resolved FROM THE DEFINITION — the one lookup the
 * signed-in, public and browse routes share.
 *
 * `stepIndex` is the flattenSteps ordinal inside the action that holds the step.
 * `callPath` (optional) walks into called actions first: each entry is the ordinal of
 * a call_action step, root first, in the action reached so far; each hop must be a
 * call_action to an own action not yet on the path, at most LIMITS.MAX_CALL_DEPTH hops.
 * The URL keeps the ROOT action id, so the role gate and the public surface stay on the
 * action that was clicked.
 *
 * @param {unknown} def
 * @param {string} actionId
 * @param {unknown} stepIndex
 * @param {unknown} [callPath]
 * @returns {{ step: import('./actionExecutor/shared').StepDef, ownerActionId: string } | { error: 'action' | 'step' | 'call' }}
 */
function resolveRequestedStep(def, actionId, stepIndex, callPath) {
    const actions = def && typeof def === 'object' ? /** @type {Record<string, unknown>} */ (def).actions : null;
    const root = ownActionOf(actions, actionId);
    if (!root) return { error: 'action' };
    const owner = followCallPath(actions, root, actionId, callPath);
    if (!owner) return { error: 'call' };
    const index = Number.isInteger(stepIndex) ? /** @type {number} */ (stepIndex) : parseInt(String(stepIndex), 10);
    const step = stepAtOrdinal(owner.action, index);
    if (!step || typeof step.kind !== 'string') return { error: 'step' };
    return { step, ownerActionId: owner.id };
}

/**
 * @param {import('./actionExecutor/shared').StepDef} action
 * @param {unknown} ordinal
 * @returns {import('./actionExecutor/shared').StepDef | null}
 */
function stepAtOrdinal(action, ordinal) {
    const steps = flattenSteps(normalizeSequence(action));
    return (Number.isInteger(ordinal) && /** @type {number} */ (ordinal) >= 0 && /** @type {number} */ (ordinal) < steps.length)
        ? steps[/** @type {number} */ (ordinal)] : null;
}

/**
 * The action a callPath ends in (the root itself for none), or null for a bad hop.
 * @param {unknown} actions
 * @param {import('./actionExecutor/shared').StepDef} root
 * @param {string} rootId
 * @param {unknown} callPath
 * @returns {{ action: import('./actionExecutor/shared').StepDef, id: string } | null}
 */
function followCallPath(actions, root, rootId, callPath) {
    const hops = Array.isArray(callPath) ? callPath : [];
    if (hops.length > LIMITS.MAX_CALL_DEPTH) return null;
    let at = { action: root, id: rootId };
    const seen = new Set([rootId]);
    for (const hop of hops) {
        const call = /** @type {Record<string, unknown> | null} */ (stepAtOrdinal(at.action, hop));
        const target = call && call.kind === 'call_action' && typeof call.actionId === 'string' ? call.actionId : null;
        const next = target && !seen.has(target) ? ownActionOf(actions, target) : null;
        if (!next || !target) return null;
        seen.add(target);
        at = { action: next, id: target };
    }
    return at;
}

/**
 * The `notes` sibling of a /step answer: the executor's remarks on a step that ran
 * (a modelTier formula that fell back, a file that could not be read), only when
 * there are any, so an answer without remarks keeps its old shape.
 *
 * @param {{ notes?: unknown } | null | undefined} result
 * @returns {{ notes?: string[] }}
 */
function stepNotes(result) {
    const notes = result && Array.isArray(result.notes) ? result.notes.filter((n) => typeof n === 'string').slice(0, 20) : [];
    return notes.length ? { notes } : {};
}

module.exports = { normalizeSequence, flattenSteps, sanitizeBag, resolveRequestedStep, stepNotes };
