// @typecheck strict
/**
 * What a run says about an iteration cap that cut a list short.
 *
 * A Loop or a "run once per item" step stops at `maxIterations` (default 100,
 * platform ceiling 1000). The tail used to be dropped with the run finishing
 * green; the only trace was `truncated`/`totalItems` inside the step output.
 * Now the cut also lands in the run's warnings and in the run summary
 * ("1 step stopped at its iteration cap: s1 processed 100 of 250 items"), the
 * same two places a mapping that found nothing is reported (bindingMisses.js).
 *
 * Only counts and step ids are recorded, never the items.
 */
'use strict';

const SUMMARY_NAMED = 2;
const MAX_RUN_TRUNCATIONS = 200;

/**
 * The unit the cap counts: batches for a batched loop, items otherwise.
 * @param {{ stepId: string; processed: number; total: number; unit: 'items' | 'batches'; implicit: boolean; }} t
 */
const unitOf = (t) => (t.unit === 'batches' ? 'batch' : 'item');

/**
 * @param {{ stepId: string; processed: number; total: number; unit: 'items' | 'batches'; implicit: boolean; }} t
 */
function describeTruncation(t) {
    const unit = unitOf(t);
    const plural = t.total === 1 ? unit : (unit === 'batch' ? 'batches' : 'items');
    const how = t.implicit ? 'the default cap' : 'its iteration cap';
    return `${t.stepId} processed ${t.processed} of ${t.total} ${plural} (stopped at ${how}; ${t.total - t.processed} not processed)`;
}

/**
 * Record one cut on the run. `ctx._truncations` is the run-level list, shared
 * by reference by every ctx copy; both targets are optional so a bare unit
 * test (or an older caller) keeps working.
 *
 * @param {{ step: { id?: string, maxIterations?: unknown }, ctx?: any, runState?: any,
 *           processed: number, total: number, unit?: 'items' | 'batches', implicitCap?: boolean }} args
 * @returns {{ stepId: string, processed: number, total: number, unit: string, implicit: boolean }}
 */
function noteTruncation({ step, ctx, runState, processed, total, unit = 'items', implicitCap }) {
    const implicit = implicitCap !== undefined ? implicitCap : !step.maxIterations;
    const entry = { stepId: step && step.id ? String(step.id) : '?', processed, total, unit, implicit };
    const run = ctx && Array.isArray(ctx._truncations) ? ctx._truncations : null;
    // One entry per step (as bindingMisses.js): a capped step inside a Loop
    // reports on every iteration and is still one line in the summary.
    const same = run && run.find((/** @type {{ stepId: string }} */ r) => r.stepId === entry.stepId);
    if (same) Object.assign(same, entry);
    else if (run && run.length < MAX_RUN_TRUNCATIONS) run.push(entry);
    const warnings = runState && Array.isArray(runState._templateWarnings) ? runState._templateWarnings : null;
    if (warnings) {
        const line = describeTruncation(entry);
        if (!warnings.includes(line)) warnings.push(line);
    }
    return entry;
}

/**
 * The summary's tail: '' for none, else " — N step(s) stopped at an iteration cap: …".
 * @param {unknown} list
 */
function truncationSummary(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const n = list.length;
    const named = list.slice(0, SUMMARY_NAMED).map(describeTruncation);
    const more = n > SUMMARY_NAMED ? ` (and ${n - SUMMARY_NAMED} more)` : '';
    return ` — ${n} step${n === 1 ? '' : 's'} stopped at an iteration cap: ${named.join('; ')}${more}`;
}

module.exports = { noteTruncation, truncationSummary, describeTruncation };
