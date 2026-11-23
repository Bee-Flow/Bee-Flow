/**
 * Who may decide a question a Cowork plan run asks (the approval steps ./plan/planIndependence.mts places in front of
 * a step, ids starting with ASK_PREFIX): the item's owner, or the colleague the owner shares the item with to decide
 * its questions, as the shares are NOW (stores/coworkShares.mts approverOf: an active member of the owner's
 * organisation). The approval row keeps the approver the run started with as its assignee; a colleague the owner took
 * off the item since, or who left the organisation, no longer decides, and is refused like anyone else who is not
 * asked.
 *
 * The automation's approval service asks this through the runner port `approvalDeciders` (./runnerPorts.js), before
 * any decision; its own rulebook (automation/approvalRulebook.js) still decides everything else.
 */

import { createRequire } from 'node:module';
import { ASK_PREFIX } from './plan/planIndependence.mts';

const nodeRequire = createRequire(import.meta.url);

/** The parts of an approval row this reads. */
export interface QuestionRow { stepId?: string | null; runId?: string | null; rootRunId?: string | null; ownerId?: string | null }

export interface DeciderDeps {
    /** The plan a journey of the engine runs, with the item's owner and the item, by the journey's first leg. */
    getPlanOfAutomationRun: (automationRunId: string) => Promise<{ userId: string; scheduleId?: string } | null>;
    /** The colleague who decides the item's questions now, or null. */
    approverOf: (scheduleId: string) => Promise<string | null>;
}

const defaults = (): DeciderDeps => ({
    getPlanOfAutomationRun: (id) => (nodeRequire('../../stores/coworkStore.js') as DeciderDeps).getPlanOfAutomationRun(id),
    approverOf: (id) => (nodeRequire('../../stores/coworkShares.mts') as typeof import('../../stores/coworkShares.mts')).coworkShares().approverOf(id),
});

/**
 * May `deciderId` decide this approval, as far as Cowork is concerned? Any approval that is no Cowork question: yes
 * (the rulebook decides). A Cowork question: only its item's owner or the item's current approver. A question whose
 * run no Cowork run started any more is decided by the automation's owner alone.
 */
export async function mayDecideQuestion(approval: QuestionRow, deciderId: string, deps: DeciderDeps = defaults()): Promise<boolean> {
    if (typeof approval.stepId !== 'string' || !approval.stepId.startsWith(ASK_PREFIX)) return true;
    if (!deciderId) return false;
    const journey = approval.rootRunId || approval.runId;
    const plan = journey ? await deps.getPlanOfAutomationRun(journey) : null;
    if (!plan) return !!approval.ownerId && approval.ownerId === deciderId;
    if (plan.userId === deciderId) return true;
    return !!plan.scheduleId && (await deps.approverOf(plan.scheduleId)) === deciderId;
}
