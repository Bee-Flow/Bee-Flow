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
const { clampErrorScope } = require('../shared/appDefinition/stepFlow.mjs');

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
 * Pre-order ordinals. Error handlers (`onError.steps`, or the legacy array
 * form) are numbered AFTER the whole main tree, in owner order, a nested
 * handler after its owner's: so every ordinal a definition without handlers
 * had stays the same, and an old client or a redacted public definition still
 * names the same step. A transaction's children are not numbered: the
 * transaction is one server step.
 *
 * Self-contained on purpose (the mobile lockstep test evaluates this
 * function's own source text): the walk is an inner closure.
 *
 * @param {import('./actionExecutor/shared').StepDef[] | null | undefined} steps
 * @param {import('./actionExecutor/shared').StepDef[]} [out]
 * @returns {import('./actionExecutor/shared').StepDef[]}
 */
function flattenSteps(steps, out = []) {
    const start = out.length;
    /** @param {unknown} list */
    const walk = (list) => {
        for (const step of (Array.isArray(list) ? list : [])) {
            if (!step || typeof step !== 'object') continue;
            out.push(step);
            if (step.kind === 'condition') {
                walk(step.then);
                walk(step.else);
            } else if (step.kind === 'loop') {
                walk(step.steps);
            } else if (step.kind === 'switch') {
                for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
                    if (c && typeof c === 'object') walk(c.steps);
                }
                walk(step.default);
            }
        }
    };
    walk(steps);
    for (let i = start; i < out.length; i++) {
        const h = out[i] && /** @type {Record<string, unknown>} */ (out[i]).onError;
        if (Array.isArray(h)) walk(h);
        else if (h && typeof h === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (h).steps)) walk(/** @type {Record<string, unknown>} */ (h).steps);
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

/**
 * The siblings of a failed /step answer beyond its fixed fields: `retryable`
 * (whether the browser's retry of the step can help) and the internal-error
 * `ref` the server log carries. Conditional, so the answer's shape grows only.
 *
 * `fieldErrors` (a field rule refused the write, stepErrors.mts) rides along
 * only when present, bounded.
 *
 * @param {{ retryable?: unknown, ref?: unknown, fieldErrors?: unknown } | null | undefined} result
 * @returns {{ retryable?: boolean, ref?: string, fieldErrors?: Record<string, string> }}
 */
function stepFailureExtras(result) {
    /** @type {{ retryable?: boolean, ref?: string, fieldErrors?: Record<string, string> }} */
    const out = {};
    if (result && typeof result.retryable === 'boolean') out.retryable = result.retryable;
    if (result && typeof result.ref === 'string' && /^[0-9a-f]{8}$/.test(result.ref)) out.ref = result.ref;
    const fieldErrors = boundedFieldErrors(result && result.fieldErrors);
    if (fieldErrors) out.fieldErrors = fieldErrors;
    return out;
}

const MAX_FIELD_ERRORS = 100;

/**
 * @param {unknown} raw
 * @returns {Record<string, string> | null}
 */
function boundedFieldErrors(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    /** @type {Record<string, string>} */
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
        if (n >= MAX_FIELD_ERRORS) break;
        if (typeof v !== 'string' || !k || k.length > 64) continue;
        out[k] = v.slice(0, 300);
        n += 1;
    }
    return n ? out : null;
}

/**
 * The `error` scope of a /step body (a step inside an onError handler), bounded; undefined when absent.
 * @param {unknown} raw
 */
function sanitizeErrorScope(raw) {
    return clampErrorScope(raw) ?? undefined;
}

module.exports = { normalizeSequence, flattenSteps, sanitizeBag, resolveRequestedStep, stepNotes, stepFailureExtras, sanitizeErrorScope };
