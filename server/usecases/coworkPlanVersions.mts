/**
 * Approving a definition that is not the one in the item's plan automation of the moment: a proposal of Cowork's own
 * (./coworkProposals.mts), or an earlier approved version brought back ("Undo", `restoreVersion`).
 *
 * Both go the one way a plan is approved. The definition is written into the item's plan automation (what its owner
 * sees in Studio), and then the plan is approved through ./coworkPlan.mts `approvePlan` with every check it makes: the
 * fingerprint of what is approved, the plan's findings, the owner's licence and account. A refused approval puts the
 * automation back as it was, so a refusal changes nothing.
 *
 * An automation that holds changes its owner has not approved is not written over: that work is theirs, and they
 * decide about it first.
 */

import { createRequire } from 'node:module';
import type { Definition } from '../core/cowork/plan/planTypes.mts';
import type { PlanState } from './coworkPlan.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

interface Item { id: string; userId: string; triggerKind?: string | null; planAutomationId?: string | null; planId?: string | null }
interface PlanVersion { version: number; definition: unknown; fingerprint: string }

export interface VersionDeps {
    store: {
        getApprovedPlan: (scheduleId: string) => Promise<PlanVersion | null>;
        getPlanVersion: (scheduleId: string, version: number) => Promise<PlanVersion | null>;
    };
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    /** Write a definition into an automation as its owner (stores/automationStore updateAutomation). */
    writeDefinition: (automationId: string, definition: unknown, userId: string) => Promise<unknown>;
    /** ./coworkPlan.mts approvePlan, with all its checks. */
    approve: (input: { item: Item; fingerprint: string; approvedBy?: string; earlierVersion?: boolean; proven?: boolean }) => Promise<PlanState>;
}

export function versionDeps(): VersionDeps {
    const automations = () => nodeRequire('../stores/automationStore') as {
        getAutomation: VersionDeps['getAutomation'];
        updateAutomation: (id: string, updates: { definition: unknown }, userId: string) => Promise<unknown>;
    };
    return {
        store: {
            getApprovedPlan: (id) => (nodeRequire('../stores/coworkStore.js') as Pick<VersionDeps['store'], 'getApprovedPlan'>).getApprovedPlan(id),
            getPlanVersion: (id, version) => (nodeRequire('../stores/coworkProposals.mts') as typeof import('../stores/coworkProposals.mts')).coworkProposals().getPlanVersion(id, version),
        },
        getAutomation: (id) => automations().getAutomation(id),
        isManaged: isManagedByStage,
        writeDefinition: (id, definition, userId) => automations().updateAutomation(id, { definition }, userId),
        approve: (input) => (nodeRequire('./coworkPlan.mts') as typeof import('./coworkPlan.mts')).approvePlan(input),
    };
}

/**
 * Write `definition` into the item's plan automation and approve it there. Refused (409) when the item has no plan
 * automation of its owner's, or when that automation holds changes that were never approved.
 */
export async function approveDefinition({ item, definition, approvedBy, earlierVersion }: { item: Item; definition: Definition; approvedBy?: string; earlierVersion?: boolean }, deps: VersionDeps = versionDeps()): Promise<PlanState> {
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!automation) throw new HttpError(409, 'cowork_plan_refused', 'This item has no plan to change.');
    const approved = await deps.store.getApprovedPlan(item.id);
    const before = automation.definition as Definition;
    if (!approved || planFingerprint(before) !== approved.fingerprint) {
        throw new HttpError(409, 'cowork_plan_draft_open', 'Your plan has changes you have not approved. Approve them or undo them first.');
    }
    await deps.writeDefinition(automation.id, definition, item.userId);
    try {
        // What comes this way carries its own proof (a replay, a try-out, an earlier approval): no try-out of the card is asked.
        return await deps.approve({ item, fingerprint: planFingerprint(definition), ...(approvedBy ? { approvedBy } : {}), ...(earlierVersion ? { earlierVersion } : {}), proven: true });
    } catch (e) {
        // A refusal changes nothing: the automation goes back to the plan that is approved.
        await deps.writeDefinition(automation.id, before, item.userId).catch((err: unknown) => fallback('usecases/coworkPlanVersions:restore', err, null));
        throw e;
    }
}

/** Approve an earlier version of the item's plan again ("Undo"), through the normal checks. */
export async function restoreVersion({ item, version }: { item: Item; version: number }, deps: VersionDeps = versionDeps()): Promise<PlanState> {
    const earlier = await deps.store.getPlanVersion(item.id, version);
    if (!earlier) throw new HttpError(404, 'cowork_plan_version_not_found', 'That version of the plan does not exist.');
    const approved = await deps.store.getApprovedPlan(item.id);
    if (approved?.fingerprint === earlier.fingerprint) throw new HttpError(409, 'cowork_plan_version_current', 'That version is the plan already.');
    return approveDefinition({ item, definition: earlier.definition as Definition, earlierVersion: true }, deps);
}
