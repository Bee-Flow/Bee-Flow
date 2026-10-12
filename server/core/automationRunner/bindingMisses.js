/**
 * What a run says about mappings that found nothing.
 *
 * dispatchStep (execution.js) runs every step inside a binding log
 * (automation/bind.js withBindingLog), so each ref, `{{…}}` or formula that
 * resolved to nothing, or failed, is written down with its input, its path and
 * where the walk stopped. This module carries those entries to the three
 * places a person (or the AI builder) can see them:
 *
 *   - the step's own row: `bindingWarnings` on recordRunStep;
 *   - the run's warnings (`runState._templateWarnings`): one readable line
 *     per miss, "s1: input "to" read trigger.output.contact.e-mail, but
 *     trigger.output.contact has no "e-mail"";
 *   - the run summary: "… — 2 mappings found nothing: s1: …".
 *
 * Only paths, field names and kinds of value are recorded — never the data.
 */
'use strict';

const { describeBindingMiss } = require('../../automation/bind');

// Run-level cap: the summary names two, the rest is a count.
const MAX_RUN_MISSES = 200;
const SUMMARY_NAMED = 2;

const sameMiss = (a, b) => a.stepId === b.stepId && a.kind === b.kind && a.path === b.path
    && a.reason === b.reason && (a.field || null) === (b.field || null);

/**
 * Record one step's misses on the run. Returns the entries for the step row,
 * or null when there were none.
 *
 * @param {{ step: object, entries: object[], ctx?: object, runState?: object }} args
 *   `ctx._bindingMisses` is the run-level list, shared by reference by every
 *   ctx copy (branches, loop bodies, layers).
 */
function noteStepBindingMisses({ step, entries, ctx, runState }) {
    if (!Array.isArray(entries) || !entries.length) return null;
    const stepId = step && step.id ? String(step.id) : '?';
    const run = ctx && Array.isArray(ctx._bindingMisses) ? ctx._bindingMisses : null;
    const warnings = runState && Array.isArray(runState._templateWarnings) ? runState._templateWarnings : null;
    for (const e of entries) {
        const rec = { stepId, ...e };
        if (run) {
            const same = run.find(r => sameMiss(r, rec));
            if (same) same.count = (same.count || 1) + (e.count || 1);
            else if (run.length < MAX_RUN_MISSES) run.push(rec);
        }
        if (warnings) {
            const line = `${stepId}: ${describeBindingMiss({ ...e, count: 1 })}`;
            if (!warnings.includes(line)) warnings.push(line);
        }
    }
    return entries.map(e => ({ ...e }));
}

/**
 * The summary's tail for a run's misses: '' for none, else
 * " — N mappings found nothing: s1: …; s2: … (and 3 more)".
 */
function bindingMissSummary(misses) {
    if (!Array.isArray(misses) || !misses.length) return '';
    const n = misses.length;
    const named = misses.slice(0, SUMMARY_NAMED).map(m => `${m.stepId}: ${describeBindingMiss(m)}`);
    const more = n > SUMMARY_NAMED ? ` (and ${n - SUMMARY_NAMED} more)` : '';
    return ` — ${n} mapping${n === 1 ? '' : 's'} found nothing: ${named.join('; ')}${more}`;
}

module.exports = { noteStepBindingMisses, bindingMissSummary };
