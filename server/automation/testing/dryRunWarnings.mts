/**
 * The warnings of a finished dry run, read off its step rows: what the run did
 * without a person, so a green dry run never hides that its approvals and
 * form pages were simulated (tests-and-docs F7, RM-4).
 *
 *   - an approval auto-approved, a form page answered with blanks (the step
 *     row's output carries `_dryRunFallback`, stamped by runDagRecord from the
 *     executor's dryRunSynthesised), a saved scenario that had nothing for a
 *     step (`_scenarioMissing`);
 *   - what an approval's routing preview found (`_preview.warnings`: a stage
 *     nobody in the organisation can decide, an attachment that resolved to
 *     nothing; core/automationRunner/dryPause.mts);
 *   - a form trigger entered with no answers, so every trigger.output value
 *     was blank.
 *
 * The run itself notes the same lines on runState (noteRunWarning), with the
 * same wording (dryPause.mts dryFallbackWarning); the run row does not keep
 * them, so POST /:id/dry-run and builder_request_dry_run read them back here.
 * Names-free: step titles or ids, never a value from the run.
 *
 * Pure.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type DryPause = typeof import('../../core/automationRunner/dryPause.mts');
const dryPause = (): DryPause => nodeRequire('../../core/automationRunner/dryPause.mts') as DryPause;

type Row = { stepId?: unknown; output?: unknown };
type StepDef = { id?: unknown; title?: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The line for a form trigger entered with no answers, or null. */
export function formTriggerWarning(trigger: { kind?: unknown } | null | undefined, payload: unknown): string | null {
    if (!trigger || trigger.kind !== 'form') return null;
    const empty = !isPlainObject(payload) || !Object.keys(payload).some((k) => !k.startsWith('_'));
    return empty
        ? 'The form trigger had no answers (no sample was given), so every trigger.output value was blank and the reads that use them were simulated.'
        : null;
}

/**
 * @param input.steps       the run's step rows (getRunSteps)
 * @param input.definition  the definition that ran, for step titles (optional)
 * @param input.trigger     the trigger the run entered through (optional)
 * @param input.triggerPayload  the payload it entered with (optional)
 */
export function dryRunWarnings(input: { steps: unknown; definition?: unknown; trigger?: { kind?: unknown } | null; triggerPayload?: unknown }): string[] {
    const { dryFallbackWarning, stepLabel } = dryPause();
    const out: string[] = [];
    const add = (line: string | null) => { if (line && !out.includes(line)) out.push(line); };
    add(formTriggerWarning(input.trigger, input.triggerPayload));

    const def = isPlainObject(input.definition) ? input.definition : {};
    const byId = new Map<string, StepDef>();
    for (const s of (Array.isArray(def.steps) ? def.steps : []) as StepDef[]) {
        if (s && typeof s.id === 'string') byId.set(s.id, s);
    }
    for (const row of (Array.isArray(input.steps) ? input.steps : []) as Row[]) {
        const o = row && isPlainObject(row.output) ? row.output : null;
        if (!o) continue;
        const id = typeof row.stepId === 'string' ? row.stepId : '';
        const label = stepLabel(byId.get(id) || { id });
        const missing = o._scenarioMissing === true;
        if (o._dryRunFallback === 'auto_approved') add(dryFallbackWarning(missing ? 'approval_scenario_missing' : 'auto_approved', label));
        if (o._dryRunFallback === 'form_blank') add(dryFallbackWarning(missing ? 'page_scenario_missing' : 'form_blank', label));
        const preview = isPlainObject(o._preview) ? o._preview : null;
        for (const w of Array.isArray(preview?.warnings) ? preview.warnings : []) {
            if (typeof w === 'string') add(w);
        }
    }
    return out;
}

const SIMULATED_PAUSE_NOTES: Record<string, string> = {
    auto_approved: 'approval auto-approved (simulated): nobody was asked, approved is true and every answer is blank here; a live run waits for a person',
    form_blank: 'form page answered with blanks (simulated): nobody filled it in, every value is empty here; a live run waits for the visitor',
};

/** The builder hint's note for an approval or form page a dry run answered without a person, or null. */
export function simulatedPauseNote(output: unknown): string | null {
    const fallback = isPlainObject(output) ? output._dryRunFallback : null;
    return typeof fallback === 'string' && Object.hasOwn(SIMULATED_PAUSE_NOTES, fallback) ? SIMULATED_PAUSE_NOTES[fallback] : null;
}

/** An output without the author-facing `_preview` key (an approval's routing preview is not a bindable field). */
export function withoutPreview<T>(output: T): T {
    if (!isPlainObject(output) || !('_preview' in output)) return output;
    const { _preview: _omit, ...rest } = output;
    return rest as T;
}
