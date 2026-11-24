/**
 * How a plan run that the automation runner calls a success really ended, for Cowork (./planRun.mts reads it after
 * every run; usecases/coworkPlanTry.mts after a try-out; ./repairs/autoResolve.mts before it repairs anything).
 *
 *   INCOMPLETE  A step that works through a list was skipped because the list it points at did not resolve to one: the
 *               path is missing from what the earlier step returned, or holds no list. The runner records such a step
 *               as 'skipped' (core/automationRunner/execCollections.js, execFlow.js); here the reference is resolved
 *               again on what the run actually recorded, with the runner's own walk (core/automationModel/bind.js
 *               walkList), so a list that resolved and was empty (no meetings this week) is never mistaken for one.
 *               That empty list is a success.
 *   AI FAILED   An AI step said it could not do its work (its verdict, core/automationRunner/aiStepVerdict.mts).
 *   SUCCESS     Neither.
 *
 * The rule between them (decision 0050): the runner's own finding wins. An unresolved reference makes the run
 * incomplete whatever an AI step said about it ("no meetings found" over a list that never arrived is not
 * "nothing to do"); a verdict can only make a would-be success worse, never better.
 *
 * Pure: the plan and the recorded steps come in. What it keeps of them is ids, the reference strings of the plan
 * itself and the KIND of value that was found, never a value.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from './plan/planTypes.mts';
import { stepsOf, refsOfValue } from './plan/planWalk.mts';
import { planViewOf } from './plan/planView.mts';
import { verdictOf, type Outcome } from '../automationRunner/aiStepVerdict.mts';

const nodeRequire = createRequire(import.meta.url);
const { walkList } = nodeRequire('../automationModel/bind.js') as { walkList: (path: string, root: unknown) => unknown };

/** Where a step names the list it works through. */
export type ListField = 'forEach.overRef' | 'overRef' | 'arrayRef';

export interface ListRef { stepId: string; field: ListField; ref: string; sourceStepId: string }

/** What a reference found instead of a list: nothing (the path is missing) or a value of another kind. */
export type Found = 'nothing' | 'null' | 'object' | 'string' | 'number' | 'boolean';

export interface Unresolved extends ListRef { stepTitle: string; sourceTitle: string; found: Found }

/** One recorded step of the run, the fields read here. */
export interface StepRecord { status?: string | null; output?: unknown; verdict?: unknown }

export type RunOutcome =
    | { kind: 'success'; verdict: Exclude<Outcome, 'failed'> | null }
    | { kind: 'incomplete'; unresolved: Unresolved[] }
    | { kind: 'ai_failed'; stepId: string; stepTitle: string; reason: string | null };

/** What a run's row keeps of its outcome (cowork_runs.outcome_json): codes, ids and the plan's own references. */
export type OutcomeFacts =
    | { kind: 'done' | 'nothing_to_do' }
    | { kind: 'incomplete'; unresolved: Array<Pick<Unresolved, 'stepId' | 'field' | 'ref' | 'sourceStepId' | 'found'>> }
    | { kind: 'ai_failed'; stepId: string };

const unwrap = (ref: string): string => {
    const t = ref.trim();
    return t.startsWith('{{') && t.endsWith('}}') ? t.slice(2, -2).trim() : t;
};

function listRefOf(stepId: string, field: ListField, raw: unknown): ListRef | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const ref = unwrap(raw);
    const [sourceStepId] = [...refsOfValue(`{{${ref}}}`).steps];
    return sourceStepId && ref.startsWith('steps.') ? { stepId, field, ref, sourceStepId } : null;
}

/** The references to an earlier step's output that a top-level step works through as a list. */
export function listRefsOf(definition: Definition | null | undefined): ListRef[] {
    const out: ListRef[] = [];
    for (const w of stepsOf(definition)) {
        if (w.parentId !== null) continue;
        const fe = w.step.forEach && typeof w.step.forEach === 'object' ? (w.step.forEach as { overRef?: unknown }) : null;
        const found = listRefOf(w.id, 'forEach.overRef', fe?.overRef)
            ?? (w.type === 'loop' ? listRefOf(w.id, 'overRef', w.step.overRef) : null)
            ?? listRefOf(w.id, 'arrayRef', w.step.arrayRef);
        if (found) out.push(found);
    }
    return out;
}

function kindOf(value: unknown): Found {
    if (value === undefined) return 'nothing';
    if (value === null) return 'null';
    if (typeof value === 'object') return 'object';
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? typeof value as Found : 'object';
}

/** The run state the references are resolved against: every recorded step's output, as the runner binds it. */
function stateOf(steps: ReadonlyMap<string, StepRecord>): { steps: Record<string, { output: unknown }> } {
    const out: Record<string, { output: unknown }> = {};
    for (const [id, s] of steps) out[id] = { output: s.output ?? null };
    return { steps: out };
}

/** The list steps the run skipped because their list did not resolve, on an earlier step that did run. */
export function unresolvedOf(definition: Definition | null | undefined, steps: ReadonlyMap<string, StepRecord>, lookups: ToolLookups): Unresolved[] {
    const titles = new Map(planViewOf(definition, lookups).steps.map((s) => [s.id, s.title]));
    const state = stateOf(steps);
    const out: Unresolved[] = [];
    for (const r of listRefsOf(definition)) {
        const own = steps.get(r.stepId);
        const source = steps.get(r.sourceStepId);
        if (own?.status !== 'skipped' || source?.status !== 'success') continue;
        const value = walkList(r.ref, state);
        if (Array.isArray(value)) continue;
        out.push({ ...r, stepTitle: titles.get(r.stepId) ?? r.stepId, sourceTitle: titles.get(r.sourceStepId) ?? r.sourceStepId, found: kindOf(value) });
    }
    return out;
}

/** How the run ended, by the rule in the header. */
export function outcomeOfRun(definition: Definition | null | undefined, steps: ReadonlyMap<string, StepRecord>, lookups: ToolLookups): RunOutcome {
    const unresolved = unresolvedOf(definition, steps, lookups);
    if (unresolved.length > 0) return { kind: 'incomplete', unresolved };
    const view = planViewOf(definition, lookups).steps;
    let verdict: Exclude<Outcome, 'failed'> | null = null;
    for (const s of view) {
        const v = verdictOf(steps.get(s.id)?.verdict);
        if (!v) continue;
        if (v.outcome === 'failed') return { kind: 'ai_failed', stepId: s.id, stepTitle: s.title, reason: v.reason };
        verdict = verdict === 'done' || v.outcome === 'done' ? 'done' : 'nothing_to_do';
    }
    return { kind: 'success', verdict };
}

/** What the run's row keeps of an outcome. */
export function factsOf(outcome: RunOutcome): OutcomeFacts | null {
    if (outcome.kind === 'incomplete') {
        return { kind: 'incomplete', unresolved: outcome.unresolved.map(({ stepId, field, ref, sourceStepId, found }) => ({ stepId, field, ref, sourceStepId, found })) };
    }
    if (outcome.kind === 'ai_failed') return { kind: 'ai_failed', stepId: outcome.stepId };
    return outcome.verdict ? { kind: outcome.verdict } : null;
}

/** The sentence the owner reads for a run that did not do its work. */
export function incompleteText(unresolved: readonly Unresolved[]): string {
    const first = unresolved[0];
    return first ? `Did not do its work: step '${first.stepTitle}' found nothing to work on.` : 'Did not do its work.';
}

/** The sentence the owner reads for a run an AI step failed. */
export function aiFailedText(reason: string | null): string {
    return `The AI says: ${reason ?? 'it could not do what the task asks.'}`;
}

/** The plain sentence of one unresolved reference, for a try-out and for a plan check. */
export function unresolvedSentence(u: Pick<Unresolved, 'ref' | 'stepTitle' | 'sourceTitle' | 'found' | 'sourceStepId'>): string {
    const prefix = `steps.${u.sourceStepId}.output.`;
    const field = u.ref.startsWith(prefix) ? u.ref.slice(prefix.length) : u.ref;
    return u.found === 'nothing'
        ? `Step '${u.stepTitle}' reads \`${field}\` from '${u.sourceTitle}', which returns no such field.`
        : `Step '${u.stepTitle}' reads \`${field}\` from '${u.sourceTitle}' as a list, but it holds ${u.found === 'object' ? 'an object' : `a ${u.found}`}.`;
}
