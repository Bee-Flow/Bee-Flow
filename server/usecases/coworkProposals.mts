/**
 * Cowork proposes its own changes, and never applies one by itself (decision 0048):
 *
 *   - a REPAIR, when the same plan step failed in the item's last two runs or its goal stayed under target three
 *     measurements in a row (core/cowork/repairs/repairTriggers.mts sets it off);
 *   - a FIXED STEP, when an AI step without tools did the same work at least ten times and a replay says a fixed step
 *     comes out the same in at least 95% of the past runs (core/cowork/cheaper/stableSteps.mts asks weekly).
 *
 * The one exception (decision 0050): a broken reference between the plan's own steps that Cowork can fix with exactly
 * the same permissions is fixed by itself (./coworkAutoResolve.mts) and kept here as an approved repair with its Undo;
 * one it cannot fix that way becomes a repair proposal like any other.
 *
 * MAKING a proposal changes nothing: the amend mode (./coworkPlanAmend.mts) works on a copy of the approved plan, the
 * copy is judged by the same rules as an approval (./coworkPlan.mts draftOf: the plan rules, the licence, the
 * organisation's policy), and a copy with any finding is dropped, never shown. Each proposal is replayed on the past
 * runs (./coworkReplay.mts), so its owner sees how it would have done. Only then is it stored, as a row of its own.
 *
 * APPROVING it writes the definition into the item's plan automation and approves it through approvePlan with every
 * check (./coworkPlanVersions.mts). A proposal made on another plan than the one approved now is stale: it is refused,
 * and the list shows it as such.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Definition, PlanPermissions, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { CoworkProposalsStore, Proposal, ProposalKind } from '../stores/coworkProposals.mts';
import type { PlanDraft, PlanState } from './coworkPlan.mts';
import type { AmendFacts, AmendInput, Amended } from './coworkPlanAmend.mts';
import type { ReplayOptions, ReplayState } from './coworkReplay.mts';
import type { RepairTrigger } from '../core/cowork/repairs/repairTriggers.mts';
import type { StableStep } from '../core/cowork/cheaper/stableSteps.mts';
import { planFingerprint, widens } from '../core/cowork/plan/planPermissions.mts';
import { changesOf, onlyStepMadeFixed, type StepChange } from '../core/cowork/plan/planChanges.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { AUTO_FIX_REASONS, WIRING_FIX_REASON } from '../core/cowork/repairs/autoResolve.mts';
import { wiringChangesOf } from '../core/cowork/plan/planWiringFix.mts';
import { changeParameter, parametersOf, type ParameterEdit } from '../core/cowork/plan/planParameters.mts';
import { sendsToOf } from '../core/cowork/planTrust.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** A fixed step is offered only when at least this share of the replayed past runs came out the same... */
export const SAME_SHARE = 0.95;
/** ...out of at least this many past runs replayed. */
export const MIN_REPLAYED = 10;

interface Item { id: string; userId: string; title?: string | null; triggerKind?: string | null; planAutomationId?: string | null; planId?: string | null }
interface Approved { id: string; version: number; definition: unknown; permissions: unknown; fingerprint: string }

export interface ProposalDeps {
    store: Pick<CoworkProposalsStore, 'createProposal' | 'getProposal' | 'listProposals' | 'openProposalOf' | 'decideProposal' | 'markStale'>;
    plans: {
        getApprovedPlan: (scheduleId: string) => Promise<Approved | null>;
        versionWithFingerprint: (scheduleId: string, fingerprint: string) => Promise<number | null>;
        /** An approved version's definition: what an automatic fix of the wiring changed is read against it. */
        getPlanVersion?: (scheduleId: string, version: number) => Promise<{ definition: unknown } | null>;
    };
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    /** The plan as approval would judge it (./coworkPlan.mts draftOf). */
    judge: (automation: SourceRow, item: Item) => Promise<PlanDraft>;
    tryDefinition: typeof import('./coworkPlanTryOut.mts').tryDefinition;
    amend: (input: AmendInput) => Promise<Amended>;
    /** Replay a definition on the past runs and wait until it is done; the state of an earlier replay. */
    replay: { run: (input: { item: Item } & ReplayOptions) => Promise<ReplayState>; stateOf: (item: Item, replayId: string) => Promise<ReplayState | null> };
    approveDefinition: (input: { item: Item; definition: Definition }) => Promise<PlanState>;
    lookups: ToolLookups;
}

/** Replay and wait: the replay use case's own work, awaited instead of left in the background. */
async function replayAndWait(input: { item: Item } & ReplayOptions): Promise<ReplayState> {
    const replay = nodeRequire('./coworkReplay.mts') as typeof import('./coworkReplay.mts');
    let work: Promise<void> = Promise.resolve();
    const deps = { ...replay.replayDeps(), inBackground: (fn: () => Promise<void>) => { work = fn(); } };
    const started = await replay.startReplay(input, deps);
    await work;
    return replay.replayStateOf({ item: input.item, replayId: started.replayId }, deps);
}

/** The real wiring; a test that only changes how a change is worked out spreads it. */
export function proposalDeps(): ProposalDeps {
    const plan = () => nodeRequire('./coworkPlan.mts') as typeof import('./coworkPlan.mts');
    const replay = () => nodeRequire('./coworkReplay.mts') as typeof import('./coworkReplay.mts');
    const lookups = toolLookups();
    const store = () => (nodeRequire('../stores/coworkProposals.mts') as typeof import('../stores/coworkProposals.mts')).coworkProposals();
    return {
        store: store(),
        plans: {
            getApprovedPlan: (id) => (nodeRequire('../stores/coworkStore.js') as Pick<ProposalDeps['plans'], 'getApprovedPlan'>).getApprovedPlan(id),
            versionWithFingerprint: (id, fp) => store().versionWithFingerprint(id, fp),
            getPlanVersion: (id, version) => store().getPlanVersion(id, version),
        },
        getAutomation: (id) => (nodeRequire('../stores/automationStore') as { getAutomation: ProposalDeps['getAutomation'] }).getAutomation(id),
        isManaged: isManagedByStage,
        judge: async (automation, item) => {
            const { mayAskByLicence } = nodeRequire('../core/cowork/plan/planLicence.mts') as typeof import('../core/cowork/plan/planLicence.mts');
            const { policyOfOwner } = nodeRequire('../core/entitlements/coworkPolicy.mts') as typeof import('../core/entitlements/coworkPolicy.mts');
            return plan().draftOf(automation, { lookups, mayAsk: mayAskByLicence, policyOf: (u) => policyOfOwner(u) }, item);
        },
        tryDefinition: (input) => (nodeRequire('./coworkPlanTryOut.mts') as typeof import('./coworkPlanTryOut.mts')).tryDefinition(input),
        amend: (input) => (nodeRequire('./coworkPlanAmend.mts') as typeof import('./coworkPlanAmend.mts')).amendPlan(input),
        replay: {
            run: replayAndWait,
            stateOf: (item, replayId) => replay().replayStateOf({ item, replayId }).catch(() => null),
        },
        approveDefinition: (input) => (nodeRequire('./coworkPlanVersions.mts') as typeof import('./coworkPlanVersions.mts')).approveDefinition(input),
        lookups,
    };
}

/** What a proposal asks: the change to work out, and what to replay it on. */
export interface ProposalRequest {
    kind: ProposalKind;
    parameter?: ParameterEdit;
    ownerRequest?: string;
    reasonCode: 'owner_request' | 'step_failed_twice' | 'goal_under_target' | 'stable_ai_step' | 'reference_unresolved' | 'wiring_broken';
    stepId: string | null;
    stepTitle: string | null;
    facts: AmendFacts;
    userOrgId?: string | null;
    bookOn?: string | null;
}

export type ProposeOutcome = 'proposed' | 'no_plan' | 'failed' | 'unchanged' | 'not_fixed' | 'findings' | 'below_threshold' | 'open_exists';

/** A replay that says a fixed step comes out the same often enough to offer it. */
export function replayPasses(state: ReplayState | null): boolean {
    if (!state || !state.done) return false;
    const replayed = state.same + state.differs + state.partial;
    return replayed >= MIN_REPLAYED && state.same / replayed >= SAME_SHARE;
}

/** The change worked out, and judged as approval would judge it; null with the reason it is not offered. */
async function workedOut(item: Item, approved: Approved, automation: SourceRow, request: ProposalRequest, deps: ProposalDeps): Promise<{ definition: Definition; draft: PlanDraft } | ProposeOutcome> {
    let definition: Definition;
    try {
        if (request.parameter) {
            const changed = changeParameter(approved.definition as Definition, request.parameter);
            if (!changed) return 'unchanged';
            definition = changed;
        } else {
            const amended = await deps.amend({
                item, approved: approved.definition as Definition, facts: request.facts, ownerRequest: request.ownerRequest,
                userOrgId: request.userOrgId ?? null, bookOn: request.bookOn ?? null,
            });
            definition = amended.definition;
        }
    } catch (e) {
        log.warn(`[Cowork] no ${request.kind} could be worked out for ${item.id}: ${(e as Error).message}`);
        return 'failed';
    }
    if (planFingerprint(definition) === approved.fingerprint) return 'unchanged';
    if (request.kind === 'fixed_step' && !onlyStepMadeFixed(approved.definition as Definition, definition, request.stepId ?? '', deps.lookups)) return 'not_fixed';
    const draft = await deps.judge({ ...automation, definition }, item);
    // A proposal with findings is dropped, never shown.
    return draft.findings.length > 0 ? 'findings' : { definition, draft };
}

/** Work out, judge, replay and keep a proposal for this item. Changes nothing of the item or its plan. */
export async function propose(item: Item, request: ProposalRequest, deps: ProposalDeps = proposalDeps()): Promise<ProposeOutcome> {
    const approved = await deps.plans.getApprovedPlan(item.id);
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!approved || !automation) return 'no_plan';
    const made = await workedOut(item, approved, automation, request, deps);
    if (typeof made === 'string') return made;
    if (request.reasonCode === 'owner_request') {
        const tried = await deps.tryDefinition({ item, automation, definition: made.definition });
        if (!tried.passed) throw new HttpError(422, 'cowork_change_test_failed', tried.problems.join(' ') || 'The changed steps did not pass their test.');
    }
    const fixed = request.kind === 'fixed_step' && request.stepId ? { onlyPlan: approved.fingerprint, outputOnly: [request.stepId] } : {};
    const replay = await deps.replay.run({ item, definition: made.definition, ...fixed }).catch((e: Error) => {
        log.info(`[Cowork] the ${request.kind} of ${item.id} was not replayed: ${e.message}`);
        return null;
    });
    if (request.kind === 'fixed_step' && !replayPasses(replay)) return 'below_threshold';
    const stored = await deps.store.createProposal({
        id: randomUUID(), scheduleId: item.id, userId: item.userId, kind: request.kind, reasonCode: request.reasonCode,
        stepId: request.stepId, stepTitle: request.stepTitle, baseFingerprint: approved.fingerprint, definition: made.definition,
        fingerprint: made.draft.fingerprint, widens: widens(made.draft.permissions, approved.permissions as PlanPermissions), replayId: replay?.replayId ?? null,
    });
    return stored ? 'proposed' : 'open_exists';
}

/** A request from the authenticated task owner, tested on a copy before it is offered. */
export async function requestChange(item: Item, edit: { instruction?: string; parameter?: ParameterEdit }, deps: ProposalDeps = proposalDeps()) {
    const existing = await deps.store.openProposalOf(item.id, 'repair');
    if (existing) throw new HttpError(409, 'cowork_open_change', 'Review the open change first.');
    const outcome = await propose(item, { kind: 'repair', reasonCode: 'owner_request', stepId: null, stepTitle: null,
        facts: { kind: 'owner_request' }, ownerRequest: edit.instruction, parameter: edit.parameter, userOrgId: await orgOfOwner(item.userId) }, deps);
    if (outcome !== 'proposed') throw new HttpError(409, 'cowork_change_unavailable', outcome === 'unchanged' ? 'The requested change produced the same steps.' : 'No tested change is available. Review the current steps and try again.');
    return proposalsOf(item, deps);
}

/** One proposal as its owner sees it. */
export interface ProposalView {
    id: string;
    kind: ProposalKind;
    reasonCode: string;
    stepId: string | null;
    stepTitle: string | null;
    status: Proposal['status'];
    fingerprint: string;
    createdAt: string | null;
    decidedAt: string | null;
    /** The steps that change; only for an open proposal. */
    changes: StepChange[];
    /** What it may newly do, in sentences. */
    widens: string[];
    replay: Pick<ReplayState, 'done' | 'total' | 'same' | 'differs' | 'partial' | 'notReplayable'> | null;
    /** An approved fixed step that is still the plan: the version "Undo" brings back. */
    undoVersion: number | null;
    /** An automatic fix of the wiring that is still the plan: who waits for whom, who reads from whom now (titles). */
    recipients?: string[];
    parameterChanges?: ParameterEdit[];
    wiring?: Array<{ kind: 'waits' | 'reads'; step: string; other: string }>;
}

/** What an automatic fix of the wiring changed, against the version Undo brings back, as titles. */
async function wiringOf(item: Item, p: Proposal, undoVersion: number | null, deps: ProposalDeps): Promise<ProposalView['wiring']> {
    if (p.reasonCode !== WIRING_FIX_REASON || undoVersion === null || !deps.plans.getPlanVersion) return undefined;
    const before = await deps.plans.getPlanVersion(item.id, undoVersion);
    const titles = new Map(planViewOf(p.definition as Definition, deps.lookups).steps.map((s) => [s.id, s.title]));
    return wiringChangesOf(before?.definition as Definition | null, p.definition as Definition)
        .map((c) => ({ kind: c.kind, step: titles.get(c.stepId) ?? c.stepId, other: titles.get(c.otherId) ?? c.otherId }));
}

async function viewOf(item: Item, p: Proposal, approved: Approved | null, deps: ProposalDeps): Promise<ProposalView> {
    const open = p.status === 'open';
    const replay = p.replayId && (open || p.kind === 'fixed_step') ? await deps.replay.stateOf(item, p.replayId) : null;
    // An approved fixed step, or a reference Cowork fixed by itself (core/cowork/repairs/autoResolve.mts), that is still the plan.
    const current = p.status === 'approved' && (p.kind === 'fixed_step' || AUTO_FIX_REASONS.has(p.reasonCode)) && approved?.fingerprint === p.fingerprint;
    const undoVersion = current ? await deps.plans.versionWithFingerprint(item.id, p.baseFingerprint) : null;
    const wiring = await wiringOf(item, p, undoVersion, deps);
    const ownerEdit = open && approved && p.reasonCode === 'owner_request';
    const before = ownerEdit ? parametersOf(approved.definition as Definition) : [];
    const parameterChanges = ownerEdit ? parametersOf(p.definition as Definition).flatMap((param) => {
        const old = before.find((b) => b.stepId === param.stepId && b.field === param.field);
        return old && old.value !== param.value ? [{ ...param, before: old.value }] : [];
    }) : [];
    return {
        ...(parameterChanges.length ? { parameterChanges } : {}),
        id: p.id, kind: p.kind, reasonCode: p.reasonCode, stepId: p.stepId, stepTitle: p.stepTitle, status: p.status, fingerprint: p.fingerprint,
        createdAt: p.createdAt, decidedAt: p.decidedAt, widens: p.widens,
        changes: open && approved ? changesOf(approved.definition as Definition, p.definition as Definition, deps.lookups) : [],
        replay: replay ? { done: replay.done, total: replay.total, same: replay.same, differs: replay.differs, partial: replay.partial, notReplayable: replay.notReplayable } : null,
        undoVersion,
        ...(open && p.reasonCode === 'owner_request' ? { recipients: [...new Set(Object.values(sendsToOf(p.definition as Definition, deps.lookups)))] } : {}),
        ...(wiring ? { wiring } : {}),
    };
}

/** An open proposal that now has a finding (the rules or the policy changed) is no longer offered: it is stale. */
async function stillAllowed(item: Item, p: Proposal, deps: ProposalDeps): Promise<boolean> {
    if (p.status !== 'open') return true;
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    const findings = automation ? (await deps.judge({ ...automation, definition: p.definition }, item)).findings : [{ code: 'gone' }];
    if (findings.length === 0) return true;
    await deps.store.decideProposal(item.id, p.id, 'stale');
    return false;
}

/** The item's proposals, newest first; an open one made on another plan than the approved one is stale. */
export async function proposalsOf(item: Item, deps: ProposalDeps = proposalDeps()): Promise<{ proposals: ProposalView[] }> {
    const approved = await deps.plans.getApprovedPlan(item.id);
    await deps.store.markStale(item.id, approved?.fingerprint ?? null);
    const views: ProposalView[] = [];
    for (const p of await deps.store.listProposals(item.id)) {
        if (await stillAllowed(item, p, deps)) views.push(await viewOf(item, p, approved, deps));
    }
    return { proposals: views };
}

/** The open proposal of the caller's item, or a 404 / 409 with the reason. */
async function openOne(item: Item, proposalId: string, deps: ProposalDeps): Promise<Proposal> {
    const p = await deps.store.getProposal(item.id, proposalId);
    if (!p) throw new HttpError(404, 'cowork_proposal_not_found', 'That proposal does not exist.');
    if (p.status !== 'open') throw new HttpError(409, 'cowork_proposal_closed', 'This proposal was already decided.');
    return p;
}

/** Approve the proposal the caller looked at (`fingerprint`): its plan becomes the approved one, through every check. */
export async function approveProposal({ item, proposalId, fingerprint }: { item: Item; proposalId: string; fingerprint: string }, deps: ProposalDeps = proposalDeps()): Promise<{ proposals: ProposalView[] }> {
    const p = await openOne(item, proposalId, deps);
    if (p.fingerprint !== fingerprint) throw new HttpError(409, 'cowork_proposal_changed', 'This is not the proposal you looked at. Look at it again.');
    const approved = await deps.plans.getApprovedPlan(item.id);
    if (approved?.fingerprint !== p.baseFingerprint) {
        await deps.store.decideProposal(item.id, p.id, 'stale');
        throw new HttpError(409, 'cowork_proposal_stale', 'The plan changed since this was proposed, so the proposal no longer fits it.');
    }
    await deps.approveDefinition({ item, definition: p.definition as Definition });
    await deps.store.decideProposal(item.id, p.id, 'approved');
    return proposalsOf(item, deps);
}

/** Not now: the proposal is put aside, and the plan stays as it is. */
export async function dismissProposal({ item, proposalId }: { item: Item; proposalId: string }, deps: ProposalDeps = proposalDeps()): Promise<{ proposals: ProposalView[] }> {
    const p = await openOne(item, proposalId, deps);
    await deps.store.decideProposal(item.id, p.id, 'dismissed');
    return proposalsOf(item, deps);
}

/** The open repair of an item that fits its approved plan, for "Needs you"; null when there is none. */
export async function openRepairOf(item: Item, approvedFingerprint: string | null, deps: Pick<ProposalDeps, 'store'> = proposalDeps()): Promise<{ proposalId: string; reasonCode: string; stepTitle: string | null } | null> {
    if (!approvedFingerprint) return null;
    const p = await deps.store.openProposalOf(item.id, 'repair');
    return p && p.reasonCode !== 'owner_request' && p.baseFingerprint === approvedFingerprint ? { proposalId: p.id, reasonCode: p.reasonCode, stepTitle: p.stepTitle } : null;
}

/** The organisation of an item's owner: the model and tiers a change is worked out with. */
async function orgOfOwner(userId: string): Promise<string | null> {
    const user = await (nodeRequire('../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(userId);
    return user?.organizationId ?? null;
}

type OrgOf = (userId: string) => Promise<string | null>;

/** A repair, set off by core/cowork/repairs/repairTriggers.mts: the facts of the trigger, nothing more. */
export async function proposeRepair(item: Item, trigger: RepairTrigger, deps: ProposalDeps = proposalDeps(), orgOf: OrgOf = orgOfOwner): Promise<ProposeOutcome> {
    const step = trigger.reasonCode === 'step_failed_twice' ? { stepId: trigger.stepId, stepTitle: trigger.stepTitle } : { stepId: null, stepTitle: null };
    const facts: AmendFacts = trigger.reasonCode === 'step_failed_twice'
        ? { kind: 'step_failed', stepId: trigger.stepId, stepTitle: trigger.stepTitle, errorClass: trigger.errorClass ?? 'Unknown', runs: trigger.runs }
        : { kind: 'goal_under', targetPercent: trigger.targetPercent, percents: trigger.percents };
    return propose(item, { kind: 'repair', reasonCode: trigger.reasonCode, ...step, facts, userOrgId: await orgOf(item.userId), bookOn: trigger.runId }, deps);
}

/** A steady AI step offered as a fixed one, set off by core/cowork/cheaper/stableSteps.mts. */
export async function offerFixedStep(item: Item, step: StableStep & { bookOn: string | null }, deps: ProposalDeps = proposalDeps(), orgOf: OrgOf = orgOfOwner): Promise<ProposeOutcome> {
    return propose(item, {
        kind: 'fixed_step', reasonCode: 'stable_ai_step', stepId: step.stepId, stepTitle: step.stepTitle,
        facts: { kind: 'make_fixed', stepId: step.stepId, stepTitle: step.stepTitle }, userOrgId: await orgOf(item.userId), bookOn: step.bookOn,
    }, deps);
}
