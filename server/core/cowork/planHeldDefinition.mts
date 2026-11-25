/**
 * The definition a plan's journey keeps across a pause (core/automationRunner/heldDefinitions.js): the plan as its
 * owner approved it, with the questions of the level the run started with (./plan/planIndependence.mts) and the run's
 * notifications held to the owner (./plan/planRunCopy.mts): exactly what the first leg ran. A run that no Cowork run started is none of Cowork's business (null).
 *
 * The copy is checked the way a run checks it before it starts (./planRun.mts): it must still have the fingerprint it
 * was approved with and belong to the automation the journey runs. A copy that fails either throws, so the journey
 * stops rather than continuing on a definition nobody approved.
 *
 * The organisation's Cowork policy is applied again as well (../entitlements/coworkPolicy.mts): a pause can last days,
 * and an administrator who made Cowork read-only, or took an app off the list of apps that may run unattended, in the
 * meantime stops the continuation with that reason (a ContinuationRefused, ../automationRunner/heldDefinitions.js).
 * The run then closes as failed with it (./planRunFollowUp.mts).
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from './plan/planTypes.mts';
import { planFingerprint } from './plan/planPermissions.mts';
import { runCopyOf } from './plan/planRunCopy.mts';
import { isIndependence, withAsks, type QuestionRoute } from './plan/planIndependence.mts';
import { questionRouteOf } from './deskQuestions.mts';
import { toolLookups } from './plan/planLookups.mts';
import { policyOfOwner, runRefusalOf, type CoworkPolicy } from '../entitlements/coworkPolicy.mts';
import { unattendedRefusal } from './planPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const { ContinuationRefused } = nodeRequire('../automationRunner/heldDefinitions.js') as { ContinuationRefused: new (message: string) => Error };

interface PlanOfRun { automationId: string; definition: unknown; fingerprint: string; independence?: string | null; trustedSteps?: string[]; scheduleId?: string; userId?: string }
export interface HeldDeps {
    getPlanOfAutomationRun: (automationRunId: string) => Promise<PlanOfRun | null>;
    /** Who decides the item's questions (./deskQuestions.mts: a desk role, or the colleague it is shared with), or null. */
    approverOf?: (scheduleId: string) => Promise<string | QuestionRoute | null>;
    /** The owner's organisation's Cowork policy (../entitlements/coworkPolicy.mts). */
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
    lookups?: ToolLookups;
}

const defaultApprover = (scheduleId: string): Promise<QuestionRoute | null> => questionRouteOf(scheduleId);

const defaults = (): HeldDeps => ({
    getPlanOfAutomationRun: (id) => (nodeRequire('../../stores/coworkStore.js') as HeldDeps).getPlanOfAutomationRun(id),
});

/** The organisation's policy, applied again as the run continues: read-only, unreadable, or an app it may not use. */
async function refuseByPolicy(definition: Definition, ownerId: string, policyOf: NonNullable<HeldDeps['policyOf']>, lookups: ToolLookups): Promise<void> {
    const policy = await policyOf(ownerId);
    const refusal = runRefusalOf(policy) ?? unattendedRefusal(definition, lookups, policy, 'this run does not continue');
    if (refusal) throw new ContinuationRefused(refusal);
}

export async function heldPlanDefinition(run: { id?: string | null; rootRunId?: string | null; automationId?: string | null }, deps: HeldDeps = defaults()): Promise<Definition | null> {
    const journey = run.rootRunId || run.id;
    if (!journey) return null;
    const plan = await deps.getPlanOfAutomationRun(journey);
    if (!plan) return null;
    if (plan.automationId !== run.automationId) throw new Error('This run belongs to another automation than the plan that started it.');
    const definition = plan.definition as Definition;
    if (planFingerprint(definition) !== plan.fingerprint) throw new Error('The stored plan is not the one that was approved, so this run does not continue.');
    const lookups = deps.lookups ?? toolLookups();
    await refuseByPolicy(definition, plan.userId ?? '', deps.policyOf ?? ((id) => policyOfOwner(id)), lookups);
    // With the questions the first leg ran with: a run from before levels asked nothing more.
    const approver = await (deps.approverOf ?? defaultApprover)(plan.scheduleId ?? '');
    return runCopyOf(withAsks(definition, isIndependence(plan.independence) ? plan.independence : 'on_its_own', lookups, new Set(plan.trustedSteps ?? []), approver));
}
