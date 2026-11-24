/**
 * The automatic fix of a broken reference (decision 0050), the part that decides: after a run of an item ended
 * INCOMPLETE (../runOutcome.mts: a step that works through a list found none, because the reference it reads points
 * at a path the earlier step's output does not have), may Cowork fix that reference by itself, and to what?
 *
 *   - SHAPE ONLY. What is read of the earlier step's actual output is its SHAPE: key paths and types
 *     (automation/shapeCache.js describeValue), never a value. Content stays out, as decision 0048 keeps the facts.
 *   - A CANDIDATE, deterministically first: a path that holds a list and whose last name is the missing one
 *     (`data.transcripts`, `result.transcripts`, `transcripts.items` is not: its last name is `items`); else the one
 *     list near the top (at most two levels down), when there is exactly one. Only when neither answers is the model
 *     asked to choose among the lists, from the shape and the step titles alone (usecases/coworkAutoResolve.mts).
 *   - A PATCH in which ONLY that reference changed (`patchRef`), reading the same earlier step: `sameReach` proves
 *     that the steps, their types, tools and inputs and the permissions are exactly equal. A fix that would reach
 *     anything else is never applied: it becomes a proposal its owner decides.
 *
 * LIMITS, asked in this order, the claim last so a refused attempt does not use up the day: the item has a plan and
 * the run followed it and ended incomplete; the organisation lets Cowork fix references (`autoFix`, on unless an
 * administrator switched it off) and has not made Cowork read-only; the item has no open repair; at most one attempt
 * per item per day, claimed in the proposals' attempts table (kind 'auto_fix') so two servers agree.
 *
 * Heard through ../runEnded.mts. `start()` is called from boot (boot/startupJobs.js) with the use case that fixes
 * (usecases/coworkAutoResolve.mts): requiring this module starts nothing, and core does not reach into the
 * application layer.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, ToolLookups } from '../plan/planTypes.mts';
import type { JudgedRun } from '../../../stores/coworkRunOutcomes.mts';
import type { CoworkProposalsStore } from '../../../stores/coworkProposals.mts';
import { stepsOf, refsOfValue } from '../plan/planWalk.mts';
import { permissionsOf } from '../plan/planPermissions.mts';
import { onRunEnded, type EndedItem } from '../runEnded.mts';
import { runRefusalOf, type CoworkPolicy } from '../../entitlements/coworkPolicy.mts';
import type { ListField } from '../runOutcome.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };
const { describeValue } = nodeRequire('../../../automation/shapeCache.js') as { describeValue: (v: unknown) => unknown };

/** Who approved a version of a plan that Cowork fixed by itself (cowork_plans.approved_by, the receipt's approvedBy). */
export const AUTO_FIX_APPROVER = 'cowork:auto_fix';
/** The reason code of the record an automatic fix leaves (cowork_proposals.reason_code), with its Undo. */
export const AUTO_FIX_REASON = 'reference_fixed';
/** One attempt per item per this long. */
export const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
/** How deep a list may sit to count as "near the top" for the one-list rule. */
const NEAR_TOP = 2;
/** How deep lists are looked for at all. */
const MAX_DEPTH = 6;

/** The unresolved reference a run's row keeps (../runOutcome.mts OutcomeFacts). */
export interface UnresolvedFact { stepId: string; field: ListField; ref: string; sourceStepId: string; found: string }

/** A list in a shape: the path to it under the step's output, as keys. */
export interface ListPath { keys: string[] }

/** The candidate a fix would use, and the rule that found it; or why none was found. */
export type Candidate =
    | { ref: string; rule: 'same_name' | 'only_list' | 'model' }
    | { ref: null; lists: ListPath[] };

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isListShape = (d: unknown): boolean => d === 'array<empty>' || (isPlain(d) && '_array' in d);
const simpleKey = (k: string): boolean => /^[A-Za-z_$][\w$]*$/.test(k);

/** The shape of a value: keys and types, never content. */
export function shapeOf(value: unknown): unknown {
    return describeValue(value);
}

/** Every list in a shape descriptor, by its path of keys (a list inside a list is not followed). */
export function listPathsOf(shape: unknown, prefix: string[] = [], depth = 0): ListPath[] {
    if (depth > MAX_DEPTH) return [];
    const node = isPlain(shape) && Object.keys(shape).length === 1 && '_json' in shape ? shape._json : shape;
    if (isListShape(node)) return prefix.length ? [{ keys: prefix }] : [];
    if (!isPlain(node)) return [];
    return Object.entries(node).flatMap(([k, v]) => (simpleKey(k) ? listPathsOf(v, [...prefix, k], depth + 1) : []));
}

/** The keys a reference reads after `steps.<source>.output.`; null when it is not that plain a path. */
export function missingKeysOf(fact: Pick<UnresolvedFact, 'ref' | 'sourceStepId'>): string[] | null {
    const prefix = `steps.${fact.sourceStepId}.output`;
    if (fact.ref !== prefix && !fact.ref.startsWith(`${prefix}.`)) return null;
    const rest = fact.ref.slice(prefix.length).replace(/^\./, '');
    const keys = rest ? rest.split('.') : [];
    return keys.every(simpleKey) ? keys : null;
}

const refFor = (sourceStepId: string, keys: string[]): string => `steps.${sourceStepId}.output${keys.length ? `.${keys.join('.')}` : ''}`;

/** The deterministic candidate for an unresolved reference, from the shape of what the step returned. */
export function deterministicCandidate(fact: UnresolvedFact, shape: unknown): Candidate {
    const missing = missingKeysOf(fact);
    const lists = listPathsOf(shape);
    if (!missing) return { ref: null, lists };
    const last = missing[missing.length - 1]?.toLowerCase();
    const named = last ? lists.filter((l) => l.keys[l.keys.length - 1]?.toLowerCase() === last) : [];
    if (named.length === 1) return { ref: refFor(fact.sourceStepId, named[0].keys), rule: 'same_name' };
    const near = lists.filter((l) => l.keys.length <= NEAR_TOP);
    if (named.length === 0 && near.length === 1 && lists.length === 1) return { ref: refFor(fact.sourceStepId, near[0].keys), rule: 'only_list' };
    return { ref: null, lists };
}

/** The reference a list path names. */
export const refOfList = (sourceStepId: string, list: ListPath): string => refFor(sourceStepId, list.keys);

function patchedStep(step: DefStep, field: ListField, ref: string): DefStep {
    if (field === 'forEach.overRef') return { ...step, forEach: { ...(step.forEach as Record<string, unknown>), overRef: ref } };
    return { ...step, [field]: ref };
}

/** The plan with ONLY that reference changed; null when the step is not a top-level step of the plan. */
export function patchRef(definition: Definition, fact: Pick<UnresolvedFact, 'stepId' | 'field'>, ref: string): Definition | null {
    if (!Array.isArray(definition.steps)) return null;
    let found = false;
    const steps = definition.steps.map((raw) => {
        const step = raw as DefStep;
        if (step?.id !== fact.stepId) return raw;
        found = true;
        return patchedStep(step, fact.field, ref);
    });
    return found ? { ...definition, steps } : null;
}

/** A step without the reference that may change, to compare everything else. */
function withoutRef(step: DefStep, field: ListField): DefStep {
    if (field === 'forEach.overRef') return { ...step, forEach: { ...(step.forEach as Record<string, unknown>), overRef: null } };
    return { ...step, [field]: null };
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, val: unknown) => (isPlain(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

/**
 * Does the patch reach exactly what the approved plan reaches? The same steps in the same order, each equal except for
 * the one reference, which still reads the same earlier step of the plan, and exactly equal permissions.
 */
export function sameReach(before: Definition, after: Definition, fact: Pick<UnresolvedFact, 'stepId' | 'field' | 'sourceStepId'>, newRef: string, lookups: ToolLookups): boolean {
    const a = stepsOf(before);
    const b = stepsOf(after);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id || a[i].type !== b[i].type) return false;
        const same = a[i].id === fact.stepId ? canonical(withoutRef(a[i].step, fact.field)) === canonical(withoutRef(b[i].step, fact.field)) : canonical(a[i].step) === canonical(b[i].step);
        if (!same) return false;
    }
    const { steps, ...restBefore } = before;
    const { steps: stepsAfter, ...restAfter } = after;
    void steps; void stepsAfter;
    if (canonical(restBefore) !== canonical(restAfter)) return false;
    const reads = [...refsOfValue(`{{${newRef}}}`).steps];
    const order = a.map((s) => s.id);
    if (reads.length !== 1 || reads[0] !== fact.sourceStepId || order.indexOf(fact.sourceStepId) < 0 || order.indexOf(fact.sourceStepId) >= order.indexOf(fact.stepId)) return false;
    return canonical(permissionsOf(before, lookups)) === canonical(permissionsOf(after, lookups));
}

export interface ResolveItem { id: string; userId: string; title?: string | null; triggerKind?: string | null; planId?: string | null; planAutomationId?: string | null; monthlyBudget?: number | null }

/** What fixes the reference (usecases/coworkAutoResolve.mts autoResolve). */
export type Resolve = (item: ResolveItem, run: JudgedRun, fact: UnresolvedFact) => Promise<unknown>;

export interface AutoResolveDeps {
    getSchedule: (id: string) => Promise<ResolveItem | null>;
    judgedRun: (scheduleId: string, runId: string) => Promise<JudgedRun | null>;
    proposals: Pick<CoworkProposalsStore, 'openProposalOf' | 'claimAttempt'>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    now: () => Date;
}

function defaults(): AutoResolveDeps {
    return {
        getSchedule: (id) => (nodeRequire('../../../stores/coworkStore.js') as { getSchedule: AutoResolveDeps['getSchedule'] }).getSchedule(id),
        judgedRun: (id, runId) => (nodeRequire('../../../stores/coworkRunOutcomes.mts') as typeof import('../../../stores/coworkRunOutcomes.mts')).coworkRunOutcomes().judgedRun(id, runId),
        proposals: (nodeRequire('../../../stores/coworkProposals.mts') as typeof import('../../../stores/coworkProposals.mts')).coworkProposals(),
        policyOf: (userId) => (nodeRequire('../../entitlements/coworkPolicy.mts') as typeof import('../../entitlements/coworkPolicy.mts')).policyOfOwner(userId),
        now: () => new Date(),
    };
}

/** The first unresolved reference a run's outcome names, as the row keeps it. */
export function unresolvedFactOf(run: JudgedRun | null): UnresolvedFact | null {
    if (run?.status !== 'incomplete' || run.outcome?.kind !== 'incomplete') return null;
    const list = (run.outcome as { unresolved?: unknown }).unresolved;
    const first = Array.isArray(list) ? list[0] as Partial<UnresolvedFact> | undefined : undefined;
    const fields: readonly string[] = ['forEach.overRef', 'overRef', 'arrayRef'];
    if (!first || typeof first.stepId !== 'string' || typeof first.ref !== 'string' || typeof first.sourceStepId !== 'string' || !fields.includes(String(first.field))) return null;
    return { stepId: first.stepId, field: first.field as ListField, ref: first.ref, sourceStepId: first.sourceStepId, found: String(first.found ?? 'nothing') };
}

export type Checked = 'no_plan' | 'not_incomplete' | 'switched_off' | 'read_only' | 'open' | 'tried_today' | 'resolving';

/** After a run of `ended` ended: may Cowork fix its broken reference now, and if so, hand it to `resolve`. */
export async function checkAfterRun(ended: EndedItem, runId: string, resolve: Resolve, deps: AutoResolveDeps = defaults()): Promise<Checked> {
    const item = await deps.getSchedule(ended.id);
    if (!item?.planId) return 'no_plan';
    const run = await deps.judgedRun(item.id, runId);
    const fact = run && run.planId === item.planId ? unresolvedFactOf(run) : null;
    if (!run || !fact) return 'not_incomplete';
    const policy = await deps.policyOf(item.userId);
    if (runRefusalOf(policy)) return 'read_only';
    if (policy.autoFix === false) return 'switched_off';
    if (await deps.proposals.openProposalOf(item.id, 'repair')) return 'open';
    if (!(await deps.proposals.claimAttempt(item.id, 'auto_fix', deps.now(), ATTEMPT_WINDOW_MS))) return 'tried_today';
    await resolve(item, run, fact);
    return 'resolving';
}

let stopListening: (() => void) | null = null;

/** Hear the runs that end, and fix with `resolve`. A second start does nothing; answers whether this one started. */
export function start(resolve: Resolve, deps?: AutoResolveDeps): boolean {
    if (stopListening) return false;
    stopListening = onRunEnded((item, runId) => {
        setImmediate(() => {
            checkAfterRun(item, runId, resolve, deps).then((c) => {
                if (c === 'resolving') log.info(`[Cowork] ${item.id}: a broken reference is being fixed`);
            }).catch((e: Error) => log.warn(`[Cowork] the reference check of ${item.id} failed: ${e.message}`));
        });
    });
    return true;
}

/** Stop hearing them (shutdown, tests). */
export function stop(): void {
    stopListening?.();
    stopListening = null;
}
