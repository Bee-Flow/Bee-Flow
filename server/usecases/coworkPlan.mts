/**
 * The plan of a Cowork item, from the routes' side (routes/coworkPlanRoutes.js, which checked the item is the
 * caller's): look at it, name the automation it is made from, approve it, take it off.
 *
 *   - LOOK. The plan is read from the automation of the moment (what its owner sees in the builder) and judged by
 *     the plan core: its steps as a person reads them, what it may do, why it may not run if it may not, and its
 *     fingerprint. Next to it: the plan that was approved, and what the plan of the moment may do that the approved
 *     one may not.
 *   - NAME. Only an automation the caller owns. A missing one and someone else's answer alike (404): an id is not a
 *     way to find out what exists.
 *   - APPROVE. The caller sends the fingerprint of the plan they looked at. If the automation changed since, that is
 *     a conflict (409) and nothing is approved: nobody approves a plan they did not see. A plan with findings cannot
 *     be approved (422). The owner must be someone the automation runner runs for (an active account whose
 *     organisation has automations): a plan that could never run is refused here rather than at its first run.
 *     What is stored is the plan as approved; a run executes that copy (core/cowork/planRun.mts).
 *   - TAKE OFF. The item runs as a prompt or as its agent again.
 *
 * An item started by an event (a new mail) carries no plan yet: its trigger is the event, and a plan's is the clock.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, PlanPermissions, PlanView, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { permissionsOf, planFingerprint, widens, BUILT_IN_APP } from '../core/cowork/plan/planPermissions.mts';
import { appsNotAllowed, policyOfOwner, OPEN_POLICY, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { asStartedBy } from '../core/cowork/startKinds.mts';
import { refFindings, REF_FINDING } from './coworkPlanRefs.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; triggerKind?: string | null; planAutomationId?: string | null; planId?: string | null }
type AutomationRow = SourceRow;
interface ApprovedPlan { id: string; version: number; fingerprint: string; approvedAt: string | null; permissions: unknown }

export interface Deps {
    store: {
        attachPlanAutomation: (scheduleId: string, automationId: string) => Promise<unknown>;
        detachPlan: (scheduleId: string) => Promise<unknown>;
        approvePlan: (input: { scheduleId: string; automationId: string; definition: unknown; permissions: unknown; fingerprint: string; approvedBy: string }) => Promise<ApprovedPlan>;
        getApprovedPlan: (scheduleId: string) => Promise<ApprovedPlan | null>;
    };
    getAutomation: (id: string) => Promise<AutomationRow | null>;
    /** The automation is managed by a Solution stage: no plan source (core/cowork/plan/planSource.mts). */
    isManaged: (automation: AutomationRow) => Promise<boolean>;
    /** The owner's licence covers a step that waits for a decision (core/cowork/plan/planLicence.mts). */
    mayAsk: MayAsk;
    /** Why the automation runner would refuse this owner, or null (core/automationRunner/ownerGate.mts). */
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    lookups: ToolLookups;
    /** The owner's organisation's Cowork policy (core/entitlements/coworkPolicy.mts); without one, the open policy. */
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
}

function defaultDeps(): Deps {
    return {
        store: nodeRequire('../stores/coworkStore.js'),
        getAutomation: (id) => (nodeRequire('../stores/automationStore') as { getAutomation: (id: string) => Promise<AutomationRow | null> }).getAutomation(id),
        isManaged: isManagedByStage,
        mayAsk: mayAskByLicence,
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: Deps['ownerRefusal'] }).ownerRefusal(owner),
        lookups: toolLookups(),
        policyOf: (userId) => policyOfOwner(userId),
    };
}

/** The plan as the automation holds it now. */
export interface PlanDraft {
    view: PlanView;
    permissions: PlanPermissions;
    findings: PlanFinding[];
    fingerprint: string;
}

/** What Cowork shows of an item's plan. */
export interface PlanState {
    /** The automation the plan is made from; null when the item has none. */
    automationId: string | null;
    /** Null when no automation is named, or it is gone or no longer the owner's. */
    draft: PlanDraft | null;
    /** The plan a run executes; null when none was approved. */
    approved: { version: number; fingerprint: string; approvedAt: string | null; permissions: PlanPermissions } | null;
    /** What the draft may do that the approved plan may not; empty when it does not widen. */
    widens: string[];
    /** The draft is exactly the approved plan. */
    upToDate: boolean;
}

/** The plan as the automation holds it now, with what the owner's licence does not cover among its findings. */
export async function draftOf(automation: AutomationRow, deps: Pick<Deps, 'lookups' | 'mayAsk' | 'policyOf'>, item: Pick<Item, 'triggerKind'> = {}): Promise<PlanDraft> {
    const definition = automation.definition as Definition;
    const owner = { userId: automation.userId, organizationId: automation.organizationId ?? null };
    const permissions = permissionsOf(definition, deps.lookups);
    const policy = deps.policyOf ? await deps.policyOf(automation.userId) : OPEN_POLICY;
    const fenced = appsNotAllowed(permissions.grants.map((g) => g.app).filter((a) => a !== BUILT_IN_APP), policy)
        .map((app): PlanFinding => ({ code: 'policy.app_not_unattended', stepId: null, message: `Your organisation does not let ${app} run while nobody watches.` }));
    return {
        view: planViewOf(definition, deps.lookups),
        permissions,
        // Checked as the item starts: an event's data is outside text (core/cowork/startKinds.mts).
        // A list a step works through that the earlier step's described output does not have (planRefs.mts).
        findings: [...checkPlan(asStartedBy(definition, item), deps.lookups), ...refFindings(definition, deps.lookups), ...await licenceFindings(definition, owner, deps.mayAsk), ...fenced],
        fingerprint: planFingerprint(definition),
    };
}

/** The automation a plan of `userId` can be made from (core/cowork/plan/planSource.mts), else null. */
const ownAutomation = (automationId: string | null | undefined, userId: string, deps: Deps): Promise<AutomationRow | null> => planSourceOf(automationId, userId, deps);

/** The plan of an item, as its owner sees it. */
export async function planStateOf(item: Item, deps: Deps = defaultDeps()): Promise<PlanState> {
    const [automation, approvedRow] = await Promise.all([
        ownAutomation(item.planAutomationId, item.userId, deps),
        deps.store.getApprovedPlan(item.id),
    ]);
    const draft = automation ? await draftOf(automation, deps, item) : null;
    const approved = approvedRow
        ? { version: approvedRow.version, fingerprint: approvedRow.fingerprint, approvedAt: approvedRow.approvedAt, permissions: approvedRow.permissions as PlanPermissions }
        : null;
    return {
        automationId: item.planAutomationId ?? null,
        draft,
        approved,
        widens: draft ? widens(draft.permissions, approved?.permissions) : [],
        upToDate: !!draft && !!approved && draft.fingerprint === approved.fingerprint,
    };
}

/** Name the automation this item's plan is made from. Approves nothing. */
export async function attachPlan({ item, automationId }: { item: Item; automationId: string }, deps: Deps = defaultDeps()): Promise<PlanState> {
    // An item that starts on a new mail may carry a plan too: it drafts its replies, never sends them (decision 0044).
    const automation = await ownAutomation(automationId, item.userId, deps);
    if (!automation) throw new HttpError(404, 'cowork_plan_refused', 'That automation does not exist.');
    await deps.store.attachPlanAutomation(item.id, automation.id);
    return planStateOf({ ...item, planAutomationId: automation.id }, deps);
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/**
 * Approve the plan the caller looked at (`fingerprint`), as the plan a run executes from now on. `approvedBy` is the
 * owner, except for Cowork's own fix of a reference (core/cowork/repairs/autoResolve.mts: AUTO_FIX_APPROVER).
 * `earlierVersion`: an approved version brought back ("Undo", ./coworkPlanVersions.mts restoreVersion); a reference
 * finding (core/cowork/plan/planRefs.mts) does not stop it, as it did not stop that version then: Undo always undoes.
 */
export async function approvePlan({ item, fingerprint, approvedBy, earlierVersion = false }: { item: Item; fingerprint: string; approvedBy?: string; earlierVersion?: boolean }, deps: Deps = defaultDeps()): Promise<PlanState> {
    const automation = await ownAutomation(item.planAutomationId, item.userId, deps);
    if (!automation) throw new HttpError(409, 'cowork_plan_refused', 'This item has no plan to approve.');
    const draft = await draftOf(automation, deps, item);
    if (draft.fingerprint !== fingerprint) {
        throw new HttpError(409, 'cowork_plan_changed', 'The plan changed since you looked at it. Look at it again, then approve it.');
    }
    const blocking = earlierVersion ? draft.findings.filter((f) => f.code !== REF_FINDING) : draft.findings;
    if (blocking.length > 0) {
        throw new HttpError(422, 'cowork_plan_not_allowed', `This plan cannot be approved yet: ${blocking[0]?.message ?? ''}`);
    }
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: automation.organizationId ?? null });
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', REFUSAL_TEXT[refusal]);
    await deps.store.approvePlan({
        scheduleId: item.id, automationId: automation.id, definition: automation.definition,
        permissions: draft.permissions, fingerprint: draft.fingerprint, approvedBy: approvedBy ?? item.userId,
    });
    return planStateOf(item, deps);
}

/** Take the plan off: the item runs as a prompt or as its agent again. */
export async function removePlan({ item }: { item: Item }, deps: Deps = defaultDeps()): Promise<PlanState> {
    await deps.store.detachPlan(item.id);
    return planStateOf({ ...item, planAutomationId: null, planId: null }, deps);
}
