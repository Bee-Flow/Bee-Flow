/**
 * Builder tool — `builder_request_dry_run`: run the draft once in test mode.
 *
 * Two ways to get the definition that runs, and the difference is the point:
 *
 *   direct build   the draft IS the saved automation: it is persisted first
 *                  (validation, trigger resync) and the saved row runs.
 *   preview turn   `draftWrap._stagedDryRun` (set by the route for Approve each
 *                  change, Plan first and a size-checked build): the definition in
 *                  front of the model is a PROPOSAL the user has not applied.
 *                  Saving it to run it would make it the live draft, so the saved
 *                  row lends only its identity (a run row needs an automation to
 *                  hang on) and the STAGED definition runs in memory.
 *
 * A dry run simulates every side-effect step either way (core/automationRunner,
 * automation/sideEffectMap.js): read-only steps run for real so the builder sees
 * genuine shapes, writes are simulated. Nothing is sent and nothing is written,
 * which is what makes it safe to offer in a preview.
 */

'use strict';

function defaultDeps() {
    return {
        getAutomation: (id) => require('../../stores/automationStore').getAutomation(id),
        getRunSteps: (runId) => require('../../stores/automationStore').getRunSteps(runId),
        executeAutomation: (automation, opts) => require('../../core/automationRunner').executeAutomation(automation, opts),
    };
}

/**
 * @param {object} draftWrap
 * @param {object} args   { triggerStepId?, triggerPayload? }
 * @param {object} deps   { persistDraft, annotate } from the facade, plus optional
 *                        getAutomation / getRunSteps / executeAutomation overrides
 */
async function applyRequestDryRun(draftWrap, args, deps) {
    const d = { ...defaultDeps(), ...(deps || {}) };
    const draft = draftWrap.def;
    // Which root to enter through: the primary unless the caller names
    // one of the additional triggers. Resolved against the DRAFT (the
    // persisted definition is the same object) so a typo is a clear
    // error rather than a run that silently entered the primary.
    let rootStepId = null;
    if (typeof args?.triggerStepId === 'string' && args.triggerStepId) {
        const known = [draft.trigger, ...(Array.isArray(draft.triggers) ? draft.triggers : [])].filter(t => t && t.id);
        const hit = known.find(t => t.id === args.triggerStepId);
        if (!hit) {
            return { error: `Unknown triggerStepId "${args.triggerStepId}". Triggers: ${known.map(t => `${t.id}(${t.kind})`).join(', ') || '(none)'}.` };
        }
        if (hit.id !== draft.trigger?.id) rootStepId = hit.id;
    }
    let automation;
    if (draftWrap._stagedDryRun) {
        if (!draftWrap.automationId) {
            return { error: 'This automation has not been saved yet, so a preview has nothing to run against. Describe what the dry run should check, and ask the user to apply the proposal first: the next turn can dry-run the saved draft.' };
        }
        const row = await d.getAutomation(draftWrap.automationId);
        if (!row || row.userId !== draftWrap.userId) {
            return { error: 'The saved automation could not be read, so the staged definition cannot be dry-run right now. Try again, or ask the user to apply the proposal first.' };
        }
        automation = { ...row, definition: structuredClone(draftWrap.def) };
    } else {
        automation = await d.persistDraft(draftWrap);
    }
    // The run is announced the moment its row exists (the route turns
    // this into a `dryrun_started` SSE event), so the canvas can follow
    // the steps live instead of showing a silent tool call for as long
    // as the run takes — a 32-file fan-out is minutes. Absent on the
    // MCP surface, where nobody is watching.
    const onRunCreated = typeof draftWrap._onDryRunStarted === 'function'
        ? (created) => { try { draftWrap._onDryRunStarted(created); } catch { /* a watcher never fails the run */ } }
        : null;
    const run = await d.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload: args?.triggerPayload || null, mode: 'dry_run', rootStepId, onRunCreated });
    const steps = await d.getRunSteps(run.id);
    const annotated = [];
    for (const s of steps) annotated.push({ ...s, _hint: await d.annotate(s, draftWrap) });
    return { run, steps: annotated };
}

module.exports = { applyRequestDryRun };
