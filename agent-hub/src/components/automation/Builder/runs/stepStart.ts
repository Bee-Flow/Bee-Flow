/**
 * How a run started from the builder ENTERS the flow: which trigger, with what
 * data, and when a form has to be filled in first. Pure helpers for
 * useBuilderRuns (split out of it), so the rules read in one place:
 *
 *   triggerById / isPrimary   the primary trigger or one of definition.triggers[]
 *   formSessionFor            the overlay session a form trigger opens
 *   isBareForm                a form nobody has filled in yet (no saved sample)
 *   triggerInput              what a run entered through a trigger carries
 *   stepStart                 ▶ on a step: the form to fill in first, or the input
 */
import { buildRealOutputMap } from '../mapping/realOutputs';
import type useAutomationBuilderStream from '@/hooks/useAutomationBuilderStream';
import type { ExecuteStepOptions } from '@/hooks/automationBuilder/useRunControls';
import type { FlowDefinition, FlowStep } from '../flow/types';
import type { FormTestSession } from '../formRunContract';
import type { FormDef } from '@/components/forms/PublicFormRenderer.types';

/** Execute options as the canvas and the step editor hand them over. */
export type ExecuteRequest = ExecuteStepOptions & { openForm?: boolean };

/** The run on the canvas and its rows, as the builder stream holds them. */
export type RunsState = Pick<ReturnType<typeof useAutomationBuilderStream>['state'], 'dryRun' | 'steps'>;

export type Trigger = FlowStep & { kind?: string; form?: unknown; pinnedOutput?: unknown };

/** The primary trigger, or the trigger (primary or additional) with that id; null when `id` names no trigger. */
export function triggerById(def: FlowDefinition | null | undefined, id: string | null): Trigger | null {
    const primary = (def?.trigger ?? null) as Trigger | null;
    if (!id) return primary;
    return ([primary, ...(def?.triggers || [])] as Array<Trigger | null>).find(tr => tr?.id === id) ?? null;
}

export const isPrimary = (def: FlowDefinition | null | undefined, tr: Trigger | null) => !!tr && tr.id === def?.trigger?.id;

/** The overlay session a form trigger opens: its declaration as it stands on screen (not the stored copy). */
export function formSessionFor(tr: Trigger | null): FormTestSession | null {
    return tr?.kind === 'form' && tr.form ? { form: tr.form as FormDef, triggerStepId: tr.id } : null;
}

/** A form trigger nobody has filled in yet: nothing to run WITH until somebody answers the page. */
export const isBareForm = (tr: Trigger | null) => tr?.kind === 'form' && tr.pinnedOutput == null;

/** A step of the root graph that the node `fromId` reaches through the edges. */
function reaches(def: FlowDefinition | null | undefined, fromId: string, stepId: string): boolean {
    if (!(def?.steps || []).some(s => s?.id === stepId)) return false;
    const seen = new Set<string>([fromId]);
    const queue: string[] = [fromId];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
        if (cur === stepId) return true;
        for (const e of def?.edges || []) {
            const to = e?.to;
            if (e?.from === cur && typeof to === 'string' && !seen.has(to)) { seen.add(to); queue.push(to); }
        }
    }
    return false;
}

/**
 * What the primary bare form gives ▶ on a step after it (`stepId`, a root step
 * it reaches): the trigger output the run on the canvas recorded (the answers a
 * form test entered with), or `undefined` when no run did. Null when the
 * primary is no bare form or does not reach the step: today's path applies.
 */
function bareFormEntry(def: FlowDefinition | null | undefined, state: RunsState, stepId: string): { trigger: Trigger; recorded: unknown } | null {
    const primary = triggerById(def, null);
    if (!primary?.id || !isBareForm(primary) || !reaches(def, primary.id, stepId)) return null;
    return { trigger: primary, recorded: buildRealOutputMap(def, state.steps, state.dryRun).get(primary.id) };
}

/**
 * What a run entered through `tr` carries (BFSF-408): that trigger's own saved
 * sample, and its id when it is not the primary one, so the server seeds the
 * DAG there. `{}` without a sample, so an untouched automation sends what it
 * always did.
 */
export function triggerInput(def: FlowDefinition | null | undefined, tr: Trigger | null): { triggerPayload?: unknown; triggerStepId?: string } {
    const sample = tr?.pinnedOutput ?? null;
    return {
        ...(sample == null ? {} : { triggerPayload: sample }),
        ...(tr && !isPrimary(def, tr) ? { triggerStepId: tr.id } : {}),
    };
}

/**
 * ▶ on a step after a bare form nobody has answered: nothing to run WITH, so
 * the form opens in dry mode and its run ends after the step ("Test step" and
 * "Run up to here" alike; "Retry from here" runs on to the end). Null when the
 * form has no question yet.
 */
function boundedFormSession(def: FlowDefinition | null | undefined, form: Trigger, stepId: string, mode: ExecuteRequest['mode']): FormTestSession | null {
    const session = formSessionFor(form);
    if (!session) return null;
    if (mode === 'from') return { ...session, mode: 'dry' };
    const step = (def?.steps || []).find(s => s?.id === stepId);
    return { ...session, mode: 'dry', untilStepId: stepId, untilLabel: String(step?.label || '') || null };
}

/**
 * How ▶ on `stepId` starts: a form page to fill in first (`form`, null when
 * that form has no question yet), or the run's input. A bare form trigger, or
 * "Test this form" (openForm) on any form trigger, opens its page in dry mode.
 * A step after a primary bare form runs with the answers the run on the canvas
 * entered it with, or, when no run has any, opens the form bounded to that
 * step (boundedFormSession). A caller's own payload always runs as it is.
 */
export function stepStart(def: FlowDefinition | null | undefined, state: RunsState, stepId: string, opts: ExecuteRequest): { form: FormTestSession | null } | { input: ExecuteStepOptions } {
    const { openForm, ...runOpts } = opts;
    const tr = triggerById(def, stepId);
    const session = formSessionFor(tr);
    if ((openForm && session) || (runOpts.triggerPayload == null && isBareForm(tr))) {
        return { form: session ? { ...session, mode: 'dry' } : null };
    }
    const bare = !tr && runOpts.triggerPayload == null ? bareFormEntry(def, state, stepId) : null;
    if (bare && bare.recorded === undefined) return { form: boundedFormSession(def, bare.trigger, stepId, runOpts.mode) };
    return {
        input: {
            ...triggerInput(def, tr ?? triggerById(def, null)),
            // Replay: the answers the run on the canvas entered the form with.
            ...(bare ? { triggerPayload: bare.recorded } : {}),
            ...runOpts,
        },
    };
}
