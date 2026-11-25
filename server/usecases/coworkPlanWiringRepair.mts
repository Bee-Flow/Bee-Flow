/**
 * Cowork fixes the WIRING of a plan that is NOT approved yet (decision 0050), so a plan drafted by an older planner or
 * named by hand does not stay stuck on "This plan cannot run as it is" when the fix is already known.
 *
 *   1. The plan of the moment (the item's plan automation, ./coworkPlan.mts), when it is not the approved one: the
 *      deterministic fixes of core/cowork/plan/planWiringFix.mts (`selfFixOf`, with the builder's shapes:
 *      ./coworkPlanRefs.mts WIRING_OPTIONS), under the rule the automatic resolver applies to an approved plan
 *      (./coworkAutoResolveWiring.mts): every blocking wiring finding answered, the same reach (`sameWiringReach`), and
 *      no finding left as approval judges it (./coworkPlan.mts draftOf).
 *   2. The fixed definition is written into the plan automation as its owner (stores/automationStore updateAutomation,
 *      the way ./coworkPlanVersions.mts writes one). It is NOT approved: its owner still approves it from the card.
 *   3. The trail gets `cowork.plan_wiring_fixed` by Cowork, with `proof: 'none'` and what changed as step ids.
 *   4. The fixed plan is tried once in test mode (./coworkPlanTryOut.mts tryDefinition: reads for real, nothing that
 *      changes or sends leaves Bee Flow), under the item's and the organisation's budget (core/cowork/spendGate.mts).
 *      The try-out record (stores/coworkPlanTries.mts) names the fix, so the card says "Fixed: ..." and "Tried once:
 *      ..."; a try-out the budget refused leaves the wiring fixed, untried, and says why.
 *
 * Refused, leaving the plan as it is: an item that is not the caller's (./coworkItems.mts), no plan, a plan that is
 * the approved one, an organisation that made Cowork read-only, nothing to fix, a finding no fix answers, or a fix that
 * reaches more. Set off right after a plan is named (routes/coworkPlanRoutes.js PUT) or drafted (./coworkPlanner.mts,
 * "make it routine" included), and by the card itself (POST /:id/plan/fix-wiring) when the plan state says
 * `wiringFixable`. What is kept is step ids, the plan's titles and its own sentences: never a value a try-out read.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { SourceRow } from '../core/cowork/plan/planSource.mts';
import type { MayAsk } from '../core/cowork/plan/planLicence.mts';
import type { CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';
import type { CoworkPlanTries, PlanTryRecord, TryStatus } from '../stores/coworkPlanTries.mts';
import type { PlanState } from './coworkPlan.mts';
import type { TryVerdict } from './coworkPlanTryOut.mts';
import { policyOfOwner, runRefusalOf } from '../core/entitlements/coworkPolicy.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { isManagedByStage, planSourceOf } from '../core/cowork/plan/planSource.mts';
import { mayAskByLicence } from '../core/cowork/plan/planLicence.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { selfFixOf, type WiringChange, type WiringFixRefusal } from '../core/cowork/plan/planWiringFix.mts';
import { WIRING_OPTIONS } from './coworkPlanRefs.mts';
import { draftOf, planStateOf } from './coworkPlan.mts';
import { planTries, recordFor, tryDefinition, untriedRecord } from './coworkPlanTryOut.mts';
import { recordAsCowork } from './coworkAudit.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

interface Item { id: string; userId: string; triggerKind?: string | null; planAutomationId?: string | null; planId?: string | null; monthlyBudget?: number | null }

export interface RepairDeps {
    /** The item, when it is the caller's (./coworkItems.mts loadOwnedItem: 404 or 403 otherwise). */
    loadItem: (id: string, userId: string) => Promise<Item>;
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    getApprovedPlan: (scheduleId: string) => Promise<{ fingerprint: string } | null>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    mayAsk: MayAsk;
    lookups: ToolLookups;
    /** Write a definition into the plan automation as its owner. */
    writeDefinition: (automationId: string, definition: Definition, userId: string) => Promise<unknown>;
    /** The trail entry `cowork.plan_wiring_fixed`, written as Cowork. */
    audit: (item: Item, fields: Record<string, unknown>) => Promise<void>;
    /** Throws when the item's or the organisation's budget is used up. */
    spendLeft: (item: Item) => Promise<void>;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    tryOut: (input: { item: Item; automation: SourceRow; definition: Definition }) => Promise<TryVerdict>;
    tries: Pick<CoworkPlanTries, 'getPlanTry' | 'setPlanTry'>;
    stateOf: (item: Item) => Promise<PlanState>;
    /** Wait for the try-out before answering; otherwise it goes on by itself and keeps its outcome on the item. */
    waitForTry?: boolean;
}

export function repairDeps(): RepairDeps {
    const automations = () => nodeRequire('../stores/automationStore') as {
        getAutomation: RepairDeps['getAutomation'];
        updateAutomation: (id: string, updates: { definition: unknown }, userId: string) => Promise<unknown>;
    };
    return {
        loadItem: (id, userId) => (nodeRequire('./coworkItems.mts') as { loadOwnedItem: RepairDeps['loadItem'] }).loadOwnedItem(id, userId),
        getAutomation: (id) => automations().getAutomation(id),
        isManaged: isManagedByStage,
        getApprovedPlan: (id) => (nodeRequire('../stores/coworkStore.js') as { getApprovedPlan: RepairDeps['getApprovedPlan'] }).getApprovedPlan(id),
        policyOf: (userId) => policyOfOwner(userId),
        mayAsk: mayAskByLicence,
        lookups: toolLookups(),
        writeDefinition: (id, definition, userId) => automations().updateAutomation(id, { definition }, userId),
        audit: (item, fields) => recordAsCowork('cowork.plan_wiring_fixed', item, fields),
        spendLeft: (item) => (nodeRequire('../core/cowork/spendGate.mts') as typeof import('../core/cowork/spendGate.mts')).assertSpendLeft(item),
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: RepairDeps['ownerRefusal'] }).ownerRefusal(owner),
        tryOut: (input) => tryDefinition(input),
        tries: planTries(),
        stateOf: (item) => planStateOf(item),
    };
}

/** Why the plan was left as it is. */
export type RepairRefusal = 'no_plan' | 'approved' | 'read_only' | WiringFixRefusal;

export interface Repaired {
    /** `fixed`: the wiring was fixed now; `tried`: it was fixed before and its try-out runs now; else why not. */
    outcome: 'fixed' | 'tried' | RepairRefusal;
    /** What changed, as step ids; empty when nothing was fixed now. */
    changes: WiringChange[];
    /** How its try-out stands: `running` while it goes on by itself; null when nothing was tried. */
    tried: TryStatus | null;
    /** Why it was not tried, as a sentence; null when it was. */
    notTried: string | null;
}

const refused = (outcome: RepairRefusal): Repaired => ({ outcome, changes: [], tried: null, notTried: null });

const OWNER_REFUSAL = Object.freeze({
    inactive: 'Not tried: this account can no longer run a plan.',
    not_entitled: 'Not tried: a plan runs on the automation engine, and your organisation does not have automations.',
});

/** Why the fixed plan cannot be tried now, as the sentence the card shows; null when it can. */
async function notTriedBecause(item: Item, automation: SourceRow, deps: RepairDeps): Promise<string | null> {
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: automation.organizationId ?? null }).catch(() => null);
    if (refusal) return OWNER_REFUSAL[refusal];
    try {
        await deps.spendLeft(item);
    } catch (e) {
        return `Not tried: ${(e as Error).message}`;
    }
    return null;
}

/** Keep how the try-out ended, when the record is still the one this try-out started (nobody started another since). */
async function closeIfOurs(scheduleId: string, running: PlanTryRecord, ended: PlanTryRecord, deps: RepairDeps): Promise<PlanTryRecord> {
    const now = await deps.tries.getPlanTry(scheduleId);
    if (now && now.status === 'running' && now.tryId === null && now.fingerprint === running.fingerprint && now.at === running.at) await deps.tries.setPlanTry(scheduleId, ended);
    return ended;
}

/** Try the fixed plan once, under the budget, keeping its outcome with what was fixed. */
async function tryFixed(item: Item, automation: SourceRow, wiring: WiringChange[], deps: RepairDeps): Promise<Pick<Repaired, 'tried' | 'notTried'>> {
    const definition = automation.definition as Definition;
    const before = await deps.tries.getPlanTry(item.id).catch(() => null);
    // A plan that needed a passing try-out before (one Cowork drafted) still does.
    const same = before && before.automationId === automation.id ? before : null;
    const extra = { required: same?.required ?? false, rounds: same?.rounds ?? 0 };
    const why = await notTriedBecause(item, automation, deps);
    if (why) {
        await deps.tries.setPlanTry(item.id, { ...untriedRecord(automation.id, definition, [why], extra), wiring });
        return { tried: 'untried', notTried: why };
    }
    const running: PlanTryRecord = { ...untriedRecord(automation.id, definition, [], extra), status: 'running', wiring };
    await deps.tries.setPlanTry(item.id, running);
    const done = deps.tryOut({ item, automation, definition })
        .then((verdict) => recordFor(automation.id, definition, verdict, { ...extra, rounds: extra.rounds + 1 }))
        .catch((e: Error) => {
            log.warn(`[Cowork] ${item.id}: the try-out of the fixed wiring did not run: ${e.message}`);
            return untriedRecord(automation.id, definition, ['Not tried: the try-out could not run. Try it again.'], extra);
        })
        .then((ended) => closeIfOurs(item.id, running, { ...ended, wiring }, deps));
    if (!deps.waitForTry) {
        done.catch((e: Error) => log.warn(`[Cowork] ${item.id}: the try-out of the fixed wiring was not kept: ${e.message}`));
        return { tried: 'running', notTried: null };
    }
    const ended = await done;
    return { tried: ended.status, notTried: ended.status === 'untried' ? ended.problems[0] ?? null : null };
}

/** Nothing to fix now: a plan whose wiring Cowork fixed earlier but could not try (the budget) is tried now. */
async function retryUntried(item: Item, automation: SourceRow, deps: RepairDeps): Promise<Repaired> {
    const record = await deps.tries.getPlanTry(item.id).catch(() => null);
    const fixedBefore = record?.automationId === automation.id && record.fingerprint === planFingerprint(automation.definition as Definition)
        && record.status === 'untried' && (record.wiring?.length ?? 0) > 0;
    if (!record || !fixedBefore) return refused('nothing');
    if ((await draftOf(automation, deps, item)).findings.length > 0) return refused('no_fix');
    return { outcome: 'tried', changes: [], ...await tryFixed(item, automation, record.wiring ?? [], deps) };
}

/** Fix the wiring of the item's plan that is not approved, store it unapproved, leave a trail entry, and try it. */
async function repairItem(item: Item, deps: RepairDeps): Promise<Repaired> {
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!automation) return refused('no_plan');
    const definition = automation.definition as Definition;
    const approved = await deps.getApprovedPlan(item.id);
    if (approved && approved.fingerprint === planFingerprint(definition)) return refused('approved');
    if (runRefusalOf(await deps.policyOf(item.userId))) return refused('read_only');
    const verdict = selfFixOf(definition, deps.lookups, WIRING_OPTIONS);
    if ('refused' in verdict) return verdict.refused === 'nothing' ? retryUntried(item, automation, deps) : refused(verdict.refused);
    const { definition: patched, changes } = verdict.fixed;
    const fixed: SourceRow = { ...automation, definition: patched };
    const judged = await draftOf(fixed, deps, item);
    if (judged.findings.length > 0) return refused('no_fix');
    await deps.writeDefinition(automation.id, patched, item.userId);
    await deps.audit(item, { stepId: changes[0]?.stepId, fingerprint: judged.fingerprint, proof: 'none', wiring: changes });
    log.info(`[Cowork] ${item.id}: the wiring of its plan that is not approved yet was fixed by itself (${changes.length} change(s))`);
    return { outcome: 'fixed', changes, ...await tryFixed(item, fixed, changes, deps) };
}

/** Fix the wiring of the caller's item's plan that is not approved, and try it. Never approves. */
export async function repairDraftWiring(itemId: string, userId: string, deps: RepairDeps = repairDeps()): Promise<Repaired> {
    return repairItem(await deps.loadItem(itemId, userId), deps);
}

const REFUSALS: Readonly<Record<RepairRefusal, { status: number; code: string; message: string }>> = Object.freeze({
    no_plan: { status: 409, code: 'cowork_plan_refused', message: 'This item has no plan to fix.' },
    approved: { status: 409, code: 'cowork_wiring_approved', message: 'This plan is the approved one: Cowork does not change it here.' },
    read_only: { status: 403, code: 'cowork_wiring_read_only', message: 'Your organisation has made Cowork read-only, so it does not change this plan.' },
    nothing: { status: 409, code: 'cowork_wiring_nothing', message: 'Nothing in the order of this plan\'s steps needs fixing.' },
    no_fix: { status: 422, code: 'cowork_wiring_no_fix', message: 'Cowork cannot fix this plan by itself. Change it in Studio, or make the plan again.' },
    reach_differs: { status: 422, code: 'cowork_wiring_reach', message: 'Fixing this plan would change what it may do, so Cowork leaves that to you. Change it in Studio.' },
});

/**
 * The route's answer (POST /:id/plan/fix-wiring, which checked the item is the caller's): what was fixed and tried, and
 * the plan as it now is. A refusal is an HttpError with its sentence.
 */
export async function fixDraftWiring({ item }: { item: Item }, deps: RepairDeps = repairDeps()): Promise<Repaired & { state: PlanState }> {
    const repaired = await repairItem(item, deps);
    if (repaired.outcome !== 'fixed' && repaired.outcome !== 'tried') {
        const refusal = REFUSALS[repaired.outcome];
        throw new HttpError(refusal.status, refusal.code, refusal.message);
    }
    return { ...repaired, state: await deps.stateOf(item) };
}

/**
 * Right after a plan was named or drafted: when Cowork can fix its wiring, it does, and the plan as it then is comes
 * back; otherwise `state` as it was. Never throws: naming or making the plan stands either way.
 */
export async function repairedState(item: Item, state: PlanState, deps: RepairDeps = repairDeps()): Promise<PlanState> {
    if (!state.wiringFixable || !state.automationId) return state;
    const named = { ...item, planAutomationId: state.automationId };
    const repaired = await repairQuietly(named, deps);
    return repaired?.outcome === 'fixed' ? deps.stateOf(named) : state;
}

/** The repair of an item whose plan was just drafted; null when it failed (the reason is in the log). */
export async function repairQuietly(item: Item, deps: RepairDeps = repairDeps()): Promise<Repaired | null> {
    try {
        return await repairItem(item, deps);
    } catch (e) {
        log.warn(`[Cowork] ${item.id}: the wiring of its plan was not fixed: ${(e as Error).message}`);
        return null;
    }
}
