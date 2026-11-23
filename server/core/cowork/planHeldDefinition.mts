/**
 * The definition a plan's journey keeps across a pause (core/automationRunner/heldDefinitions.js): the plan as its
 * owner approved it, with the run's notifications held to the owner (./plan/planRunCopy.mts), exactly what the first
 * leg ran. A run that no Cowork run started is none of Cowork's business (null).
 *
 * The copy is checked the way a run checks it before it starts (./planRun.mts): it must still have the fingerprint it
 * was approved with and belong to the automation the journey runs. A copy that fails either throws, so the journey
 * stops rather than continuing on a definition nobody approved.
 */

import { createRequire } from 'node:module';
import type { Definition } from './plan/planTypes.mts';
import { planFingerprint } from './plan/planPermissions.mts';
import { runCopyOf } from './plan/planRunCopy.mts';

const nodeRequire = createRequire(import.meta.url);

interface PlanOfRun { automationId: string; definition: unknown; fingerprint: string }
export interface HeldDeps { getPlanOfAutomationRun: (automationRunId: string) => Promise<PlanOfRun | null> }

const defaults = (): HeldDeps => ({
    getPlanOfAutomationRun: (id) => (nodeRequire('../../stores/coworkStore.js') as HeldDeps).getPlanOfAutomationRun(id),
});

export async function heldPlanDefinition(run: { id?: string | null; rootRunId?: string | null; automationId?: string | null }, deps: HeldDeps = defaults()): Promise<Definition | null> {
    const journey = run.rootRunId || run.id;
    if (!journey) return null;
    const plan = await deps.getPlanOfAutomationRun(journey);
    if (!plan) return null;
    if (plan.automationId !== run.automationId) throw new Error('This run belongs to another automation than the plan that started it.');
    const definition = plan.definition as Definition;
    if (planFingerprint(definition) !== plan.fingerprint) throw new Error('The stored plan is not the one that was approved, so this run does not continue.');
    return runCopyOf(definition);
}
