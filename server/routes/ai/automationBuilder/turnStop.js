// @typecheck noImplicitAny
/**
 * Automation Builder — the turn's iteration ceiling and how a turn the model
 * cannot finish is stopped: the label and position of the step that kept
 * failing, and the ONE sentence the user reads about it. Moved from
 * ./chatStream.js; the stop decision itself lives in ./buildLoop.js.
 */

// The AI may need: propose_trigger → multiple add_*  → summarise → dry_run
// → fix → dry_run → finalize. This is a ceiling; the per-model profile
// (server/automation/builderModelProfiles.js) chooses its own budget within
// this ceiling — small / reasoning models get more headroom because they
// take more turns to converge.
const MAX_ITERATIONS = 24;

// ── Stopping a turn the model cannot finish ─────────────────────────
//
// Two stops besides the iteration budget. `repeated_rejection`: the repeat
// ladder (builderTools.js rejectionLadder) stamps `_stop` on the third
// identical rejection — measured 2026-09-12/13 with the fast local model,
// which resent one refused batch three rounds running and a refused
// builder_update_steps fifteen times, "stop retrying" in the hint included.
// `no_progress`: four rounds in which EVERY call was refused, with the
// calls differing just enough to dodge the ladder. Both end the turn with
// one sentence to the user; nothing after the stop runs, so a finalize in
// the same reply cannot save a draft the model was still fighting with.
const WASTED_ROUNDS_LIMIT = 4;
const STOP_ERROR_HEAD = 200;

/**
 * The arguments of a builder tool call, as far as the stop wording reads them.
 * @typedef {{ label?: string, tool?: string, stepId?: string,
 *   steps?: Array<{ type?: string, spec?: { label?: string, tool?: string } }> }} StopCallArgs
 */

/**
 * What to call the step that kept failing: its label, its tool, its type.
 * @param {string} name
 * @param {StopCallArgs | null | undefined} args  the call's parsed arguments
 * @param {{ failedIndex?: number } | null | undefined} result  the refused result
 * @returns {string}
 */
function rejectedCallLabel(name, args, result) {
    const steps = Array.isArray(args?.steps) ? args.steps : null;
    const entry = name === 'builder_add_steps' && steps && Number.isInteger(result?.failedIndex) ? steps[result.failedIndex] : null;
    const spec = entry ? (entry.spec && typeof entry.spec === 'object' ? entry.spec : {}) : (args && typeof args === 'object' ? args : {});
    const type = entry ? entry.type : name.replace(/^builder_(add_)?/, '');
    return [spec.label, spec.tool, type].find(v => typeof v === 'string' && v) || name;
}

/**
 * The 1-based position the user sees for the step that was refused: the
 * batch entry's index; else the step the call names (an update); else the
 * slot a new step would have taken.
 * @param {import('../../../automation/builderTools/draftGraph').DraftGraph | null | undefined} def
 * @param {StopCallArgs | null | undefined} args
 * @param {number | undefined} entryIndex
 */
function rejectedStepPosition(def, args, entryIndex) {
    if (Number.isInteger(entryIndex)) return entryIndex + 1;
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const stepId = typeof args?.stepId === 'string' ? args.stepId : null;
    const at = stepId ? steps.findIndex(s => s && s.id === stepId) : -1;
    return at >= 0 ? at + 1 : steps.length + 1;
}

/**
 * ONE sentence for the user, the same in the stream and in the stored turn.
 * @param {NonNullable<import('./turnSetup').BuilderTurn['stopReason']>} stop
 * @param {import('../../../automation/builderTools/draftGraph').DraftGraph | null | undefined} def
 */
function stopSentence(stop, def) {
    const k = Array.isArray(def?.steps) ? def.steps.length : 0;
    const inPlace = `${k} step${k === 1 ? '' : 's'} ${k === 1 ? 'is' : 'are'} in place.`;
    if (stop.reason === 'no_progress') {
        return `I made no progress for four rounds — the builder rejected every step I tried. ${inPlace} Tell me how to proceed.`;
    }
    const err = String(stop.error || '').replace(/\s+/g, ' ').trim();
    const cut = err.length > STOP_ERROR_HEAD ? `${err.slice(0, STOP_ERROR_HEAD).trimEnd()}…` : err;
    const head = /[.!?…]$/.test(cut) ? cut : `${cut}.`;
    return `I could not build step ${stop.position} (${stop.label}): the builder kept rejecting it — ${head} ${inPlace} Tell me how to proceed, or fix that step on the canvas.`;
}

module.exports = { MAX_ITERATIONS, WASTED_ROUNDS_LIMIT, STOP_ERROR_HEAD, rejectedCallLabel, rejectedStepPosition, stopSentence };
