/**
 * What a plan needs of its owner's licence, beyond being a plan (./planChecks.mts is the licence-free part).
 *
 * A step that waits for a decision is an approval step of the automation engine, and approvals are an Enterprise
 * capability: the engine refuses such a step without it (core/automationRunner/dryPause.mts), in a run and in a
 * try-out. Said here as a finding, the plan card shows it before anything is approved, instead of the first run
 * failing on it.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding } from './planTypes.mts';
import { isAnnotation, kindOfStepType } from './coworkStepList.mts';
import { stepsOf } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);

export interface Owner { userId: string; organizationId?: string | null }
export type MayAsk = (owner: Owner) => Promise<boolean>;

/**
 * The real answer: the engine's own check of an approval step (core/automationRunner/dryPause.mts), so the plan card
 * and a run can never disagree about it.
 */
export const mayAskByLicence: MayAsk = async (owner) => {
    const { assertApprovalsLicensed } = nodeRequire('../../automationRunner/dryPause.mts') as {
        assertApprovalsLicensed: (ctx: { userId?: string; orgId?: string }, mode: string) => Promise<void>;
    };
    try {
        await assertApprovalsLicensed({ userId: owner.userId, orgId: owner.organizationId ?? undefined }, 'live');
        return true;
    } catch (e) {
        if ((e as { errorClass?: unknown }).errorClass === 'license_required') return false;
        throw e;
    }
};

export const LICENCE_FINDING_TEXT = 'A step that waits for your decision needs approvals, which your organisation\'s Bee Flow plan does not include. Take the step out, or ask your administrator.';

/** Why this plan cannot run for this owner, as findings; none when the licence covers it. */
export async function licenceFindings(definition: Definition | null | undefined, owner: Owner, mayAsk: MayAsk = mayAskByLicence): Promise<PlanFinding[]> {
    const asks = stepsOf(definition).filter((s) => !isAnnotation(s.type) && kindOfStepType(s.type) === 'ask');
    if (asks.length === 0 || await mayAsk(owner)) return [];
    return asks.map((s) => ({ code: 'ask.not_licensed', stepId: s.id, message: LICENCE_FINDING_TEXT }));
}
