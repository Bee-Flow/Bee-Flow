/**
 * Replay gaps — step outputs a resume cannot restore (BFSF-435).
 *
 * A resume rebuilds runState from the persisted run-step rows and never
 * dispatches a step before its pause again: that would repeat a paid call or
 * a sent mail. A row the run history truncated comes back only when its full
 * copy was kept (stores/automationStore/runFullOutputs.js). A sentinel written
 * before those copies existed, or one too large to keep, is a GAP.
 *
 * Carrying on past a gap is how BFSF-435 lost data: every
 * `steps.<id>.output…` binding after the pause resolved to nothing and the
 * run finished green, having written or sent empty values. So a gap that a
 * step after the pause reads fails the resumed run, saying which step and
 * why; a gap nothing after the pause reads costs nothing and is let through.
 *
 * Pure: no store, no runner — resume.js finds the gaps, runDag enforces them.
 */

const { AutomationError } = require('../automationErrors');
const { stepIdsRead } = require('../../shared/mapping/index.mjs');

/** Every step reachable from `fromStepId` along the definition's edges. */
function stepsAfter(definition, fromStepId) {
    const out = new Set();
    if (!fromStepId) return out;
    const adj = new Map();
    for (const e of (Array.isArray(definition?.edges) ? definition.edges : [])) {
        if (!e || !e.from || !e.to) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
    }
    const todo = [fromStepId];
    while (todo.length) {
        for (const to of (adj.get(todo.pop()) || [])) {
            if (out.has(to) || to === fromStepId) continue;
            out.add(to);
            todo.push(to);
        }
    }
    return out;
}

/**
 * Does anything in `step` (bindings, refs, templates, a loop body, a layer
 * call's inputs — all of it is in the step's own JSON) read `steps.<stepId>`?
 * Dotted and bracketed forms both count; `steps.ai_1` does not match
 * `steps.ai_10`. A pick or a compose names its step as data
 * (`{root:'steps', id:'ai_1'}`), so those are asked of the shared mapping
 * core (stepIdsRead). Deliberately generous: a false "yes" fails a resume
 * that could have limped on, a false "no" is the silent data loss this
 * exists for.
 */
function readsStep(step, stepId) {
    if (!step || !stepId) return false;
    if (stepIdsRead(step).includes(String(stepId))) return true;
    const esc = String(stepId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // In the serialized step a quote inside a string is escaped (\"), hence
    // the optional backslash before the bracket form's quotes.
    const re = new RegExp(`steps(?:\\.${esc}(?![\\w-])|\\[\\s*\\\\?['"]${esc}\\\\?['"]\\s*\\])`);
    let text;
    try { text = JSON.stringify(step); } catch { return true; }
    return re.test(text || '');
}

/**
 * The gaps that matter: those some step after the pause reads.
 *
 * @param {object} definition           the routine being resumed
 * @param {string} fromStepId           the step the run paused on
 * @param {Map<string, number|null>} gaps  stepId → original size in bytes
 * @returns {Map<string, number|null>}  the subset a later step reads
 */
function gapsReadAfterPause(definition, fromStepId, gaps) {
    const out = new Map();
    if (!gaps || gaps.size === 0) return out;
    const after = stepsAfter(definition, fromStepId);
    const later = (Array.isArray(definition?.steps) ? definition.steps : []).filter(s => s && after.has(s.id));
    for (const [stepId, bytes] of gaps) {
        if (later.some(s => s.id !== stepId && readsStep(s, stepId))) out.set(stepId, bytes);
    }
    return out;
}

function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(n / 1024)} KB`;
}

/** The error a resumed run fails with when it reaches a gap a later step reads. */
function replayGapError(stepId, originalBytes) {
    const size = formatBytes(Number(originalBytes));
    const err = new AutomationError(
        `The output of step ${stepId}${size ? ` (${size})` : ''} was too large to keep for this resume, `
        + 'and the steps after the pause need it. Start the routine again so the step runs once more',
    );
    err.replayGap = { stepId, originalBytes: Number(originalBytes) || null };
    return err;
}

module.exports = { stepsAfter, readsStep, gapsReadAfterPause, replayGapError };
