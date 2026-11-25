/**
 * The goal of a Cowork item, from the routes' side (routes/coworkGoalRoutes.js, which checked the item is the
 * caller's): look at it, write it, have its check drafted, approve the check, take the goal off.
 *
 *   - LOOK. The sentence and the target, the check as its automation holds it now (its steps in plain words, whether
 *     it only reads, why it may not measure if it may not, and its fingerprint), the check that was approved, and
 *     what it measured: the last count, the measurements newest first, and which way they go.
 *   - WRITE. A new sentence takes the check off (stores/coworkGoals.mts): it was drafted for the old one.
 *   - DRAFT. The goal planner (./coworkGoalPlanner.mts) drafts a check from the sentence; it is not approved.
 *   - APPROVE. The caller sends the fingerprint of the check they read. If the check changed since, that is a
 *     conflict (409) and nothing is approved. A check that is not one (core/cowork/goals/goalCheck.mts) cannot be
 *     approved (422), and neither can one for an owner the automation runner would refuse. What is stored is the
 *     check as approved: a measurement runs that copy.
 *   - TAKE OFF. The goal and what it measured go.
 */

import { createRequire } from 'node:module';
import type { Definition, Effect, PlanFinding, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { CoworkGoalsStore, Goal, GoalResult } from '../stores/coworkGoals.mts';
import type { DraftCheckInput, DraftedCheck } from './coworkGoalPlanner.mts';
import { goalCheckFindings } from '../core/cowork/goals/goalCheck.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null }

export interface GoalDeps {
    store: Pick<CoworkGoalsStore, 'getGoal' | 'saveGoal' | 'approveCheck' | 'removeGoal' | 'listResults'>;
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    draft: (input: DraftCheckInput) => Promise<DraftedCheck>;
    lookups: ToolLookups;
}

function defaultDeps(): GoalDeps {
    return {
        store: (nodeRequire('../stores/coworkGoals.mts') as typeof import('../stores/coworkGoals.mts')).coworkGoals(),
        getAutomation: (id) => (nodeRequire('../stores/automationStore') as { getAutomation: GoalDeps['getAutomation'] }).getAutomation(id),
        isManaged: isManagedByStage,
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: GoalDeps['ownerRefusal'] }).ownerRefusal(owner),
        draft: (input) => (nodeRequire('./coworkGoalPlanner.mts') as typeof import('./coworkGoalPlanner.mts')).draftGoalCheck(input),
        lookups: toolLookups(),
    };
}

/** One step of the check as its owner reads it. */
export interface CheckStep { id: string; title: string; type: string; effect: Effect; app: string | null; depth: number }

/** The check as its automation holds it now. */
export interface CheckView {
    automationId: string;
    steps: CheckStep[];
    /** Every step only reads, and nothing stops it from measuring. */
    readsOnly: boolean;
    findings: PlanFinding[];
    fingerprint: string;
}

export interface GoalCountView { met: number; total: number; percent: number; period: string | null; measuredAt: string | null }

export interface GoalView {
    sentence: string;
    targetPercent: number;
    /** Null while no check was drafted, or its automation is gone or no longer the owner's. */
    check: CheckView | null;
    approved: { fingerprint: string; approvedAt: string | null } | null;
    /** The check of the moment is exactly the approved one. */
    upToDate: boolean;
    /** The latest good count; null before the first. */
    count: GoalCountView | null;
    /** The measurements, newest first: a failed one says why. */
    results: GoalResult[];
    /** The latest good count against the one before it; null with fewer than two. */
    trend: 'up' | 'down' | 'flat' | null;
}

export const RESULTS_SHOWN = 12;

const percentOf = (met: number, total: number): number => (total > 0 ? Math.round((met / total) * 100) : 100);

function countViewOf(r: GoalResult): GoalCountView | null {
    if (!r.ok || r.met === null || r.total === null) return null;
    return { met: r.met, total: r.total, percent: percentOf(r.met, r.total), period: r.period, measuredAt: r.measuredAt };
}

function trendOf(counts: GoalCountView[]): GoalView['trend'] {
    const [latest, before] = counts;
    if (!latest || !before) return null;
    const moved = latest.percent - before.percent;
    return moved > 0 ? 'up' : moved < 0 ? 'down' : 'flat';
}

/** The check as its automation holds it now, judged by the rules of a check. */
async function checkViewOf(goal: Goal, deps: GoalDeps): Promise<CheckView | null> {
    const automation = await planSourceOf(goal.checkAutomationId, goal.userId, deps);
    if (!automation) return null;
    const definition = automation.definition as Definition;
    const findings = goalCheckFindings(definition, deps.lookups);
    const steps = planViewOf(definition, deps.lookups).steps.map((s) => ({ id: s.id, title: s.title, type: s.type, effect: s.effect, app: s.app, depth: s.depth }));
    return { automationId: automation.id, steps, readsOnly: findings.length === 0 && steps.every((s) => s.effect === 'reads'), findings, fingerprint: planFingerprint(definition) };
}

async function viewOf(goal: Goal, deps: GoalDeps): Promise<GoalView> {
    const [check, results] = await Promise.all([checkViewOf(goal, deps), deps.store.listResults(goal.scheduleId, RESULTS_SHOWN)]);
    const counts = results.map(countViewOf).filter((c): c is GoalCountView => c !== null);
    const approved = goal.approvedDefinition && goal.fingerprint ? { fingerprint: goal.fingerprint, approvedAt: goal.approvedAt } : null;
    return {
        sentence: goal.sentence, targetPercent: goal.targetPercent, check, approved,
        upToDate: !!check && !!approved && check.fingerprint === approved.fingerprint,
        count: counts[0] ?? null, results, trend: trendOf(counts),
    };
}

/** The goal of an item, as its owner sees it. */
export async function goalOf(item: Item, deps: GoalDeps = defaultDeps()): Promise<{ goal: GoalView | null }> {
    const goal = await deps.store.getGoal(item.id);
    return { goal: goal ? await viewOf(goal, deps) : null };
}

/** Write the goal's sentence and target. */
export async function saveGoal({ item, sentence, targetPercent }: { item: Item; sentence: string; targetPercent: number }, deps: GoalDeps = defaultDeps()): Promise<{ goal: GoalView | null }> {
    await deps.store.saveGoal({ scheduleId: item.id, userId: item.userId, sentence: sentence.trim(), targetPercent });
    return goalOf(item, deps);
}

/** Have the check of the goal drafted from its sentence. Approves nothing. */
export async function draftCheck(input: Omit<DraftCheckInput, 'goal'>, deps: GoalDeps = defaultDeps()): Promise<{ summary: string; goal: GoalView | null }> {
    const goal = await deps.store.getGoal(input.item.id);
    if (!goal) throw new HttpError(409, 'cowork_goal_refused', 'Write the goal first: the check is drafted from it.');
    const drafted = await deps.draft({ ...input, goal: { sentence: goal.sentence, targetPercent: goal.targetPercent } });
    return { summary: drafted.summary, ...await goalOf(input.item, deps) };
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a check.',
    not_entitled: 'A goal\'s check runs on the automation engine, and your organisation does not have automations.',
});

/** Approve the check the caller read (`fingerprint`), as the check a measurement runs from now on. */
export async function approveCheck({ item, fingerprint }: { item: Item; fingerprint: string }, deps: GoalDeps = defaultDeps()): Promise<{ goal: GoalView | null }> {
    const goal = await deps.store.getGoal(item.id);
    const automation = goal ? await planSourceOf(goal.checkAutomationId, item.userId, deps) : null;
    if (!goal || !automation) throw new HttpError(409, 'cowork_goal_refused', 'This goal has no check to approve.');
    const definition = automation.definition as Definition;
    if (planFingerprint(definition) !== fingerprint) {
        throw new HttpError(409, 'cowork_goal_check_changed', 'The check changed since you read it. Read it again, then approve it.');
    }
    const findings = goalCheckFindings(definition, deps.lookups);
    if (findings.length > 0) throw new HttpError(422, 'cowork_goal_check_not_allowed', `This check cannot be approved: ${findings[0]?.message ?? ''}`);
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: automation.organizationId ?? null });
    if (refusal) throw new HttpError(403, 'cowork_goal_refused', REFUSAL_TEXT[refusal]);
    await deps.store.approveCheck(item.id, { definition, fingerprint });
    return goalOf(item, deps);
}

/** Take the goal off, with what it measured. */
export async function removeGoal({ item }: { item: Item }, deps: GoalDeps = defaultDeps()): Promise<{ goal: null }> {
    await deps.store.removeGoal(item.id);
    return { goal: null };
}
