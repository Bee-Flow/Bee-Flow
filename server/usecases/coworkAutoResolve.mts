/**
 * The automatic fix of a broken reference (decision 0050), the part that acts. Set off by
 * core/cowork/repairs/autoResolve.mts after a run ended INCOMPLETE, once its limits allowed it (the organisation's
 * `autoFix`, not read-only, no open repair, one attempt per item per day).
 *
 *   1. The SHAPE of what the earlier step really returned in that run (its recording; keys and types, never values)
 *      gives the candidate: by name or as the one list near the top, deterministically; only when neither answers,
 *      the model chooses among the lists from the shape's paths and the step titles alone, under the item's and the
 *      organisation's budget (core/cowork/spendGate.mts).
 *   2. The patched plan changes ONLY that reference, and must reach exactly what the approved one reaches
 *      (`sameReach`: same steps, tools, inputs and permissions) and be a plan approval allows (./coworkPlan.mts
 *      draftOf: no finding).
 *   3. It is replayed on that run's own recording (core/cowork/replay/replayRun.mts replayOnRecording): the step must
 *      now get its list and nothing may fail.
 *   4. Then, and only then, it is approved as a new version through the versioning the repairs use
 *      (./coworkPlanVersions.mts approveDefinition), by AUTO_FIX_APPROVER: a record the item shows with its Undo
 *      (stores/coworkProposals.mts recordAutoFix; Undo is restoreVersion), and a trail entry `cowork.plan_auto_fixed`.
 *   5. A scheduled item runs once more right away, through the Cowork runner (core/cowork/coworkRunner.js
 *      executeCowork), so the policy and the budgets apply. That run cannot set off another fix: the day's attempt is
 *      used.
 *
 * Whatever fails on the way falls back to the repair its owner decides (./coworkProposals.mts propose): the patched
 * plan when there is one (its widening is then shown), else the facts of the reference for the amend mode. Nothing that
 * widens what the plan may do is ever applied here.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { JudgedRun } from '../stores/coworkRunOutcomes.mts';
import type { CoworkProposalsStore } from '../stores/coworkProposals.mts';
import type { PlanDraft, PlanState } from './coworkPlan.mts';
import type { ProposalDeps, ProposeOutcome } from './coworkProposals.mts';
import type { PastRun, ReplayRunDeps } from '../core/cowork/replay/replayRun.mts';
import type { RecordedStep } from '../core/cowork/replay/recordingOf.mts';
import { AUTO_FIX_APPROVER, AUTO_FIX_REASON, deterministicCandidate, listPathsOf, patchRef, refOfList, sameReach, shapeOf, type ListPath, type ResolveItem, type UnresolvedFact } from '../core/cowork/repairs/autoResolve.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { planSourceOf, isManagedByStage, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { unresolvedOf } from '../core/cowork/runOutcome.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

interface Approved { id: string; version: number; definition: unknown; fingerprint: string }

/** Choose one of `lists` for the step, from the paths and the titles alone; answers its index, or null. */
export type ChooseList = (input: { item: ResolveItem; stepTitle: string; sourceTitle: string; missing: string; lists: string[]; bookOn: string }) => Promise<number | null>;

export interface AutoResolveDeps {
    getApprovedPlan: (scheduleId: string) => Promise<Approved | null>;
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    /** The recorded steps of an automation run, and the engine, for the replay. */
    replay: ReplayRunDeps;
    replayOnRecording: typeof import('../core/cowork/replay/replayRun.mts').replayOnRecording;
    /** The plan as approval would judge it (./coworkPlan.mts draftOf). */
    judge: (automation: SourceRow, item: ResolveItem) => Promise<PlanDraft>;
    approveDefinition: (input: { item: ResolveItem; definition: Definition; approvedBy: string }) => Promise<PlanState>;
    proposals: Pick<CoworkProposalsStore, 'recordAutoFix'>;
    /** The trail entry, written as Cowork itself in the owner's organisation. */
    audit: (item: ResolveItem, fields: Record<string, unknown>) => Promise<void>;
    /** The fallback: a repair its owner decides (./coworkProposals.mts propose). */
    propose: (item: ResolveItem, request: Parameters<typeof import('./coworkProposals.mts').propose>[1], deps?: ProposalDeps) => Promise<ProposeOutcome>;
    proposalDeps: () => ProposalDeps;
    chooseList: ChooseList | null;
    /** Throws when the item's or the organisation's budget is used up (core/cowork/spendGate.mts). */
    spendLeft: (item: ResolveItem) => Promise<void>;
    /** Run the item once more now, through the Cowork runner (its policy and budgets). */
    rerun: (item: ResolveItem) => Promise<unknown>;
    lookups: ToolLookups;
}

export type ResolveOutcome = 'fixed' | 'fixed_and_rerun' | 'proposed' | 'not_fixed';

/** The real wiring; a test that only changes the model, the rerun or the replay spreads it. */
export function autoResolveDeps(): AutoResolveDeps {
    const automations = () => nodeRequire('../stores/automationStore') as {
        getAutomation: AutoResolveDeps['getAutomation'];
        getRun: ReplayRunDeps['getRun']; getRunStepsForChain: ReplayRunDeps['getRunStepsForChain']; getRunFullOutput: ReplayRunDeps['getRunFullOutput'];
    };
    const proposals = () => nodeRequire('./coworkProposals.mts') as typeof import('./coworkProposals.mts');
    const lookups = toolLookups();
    return {
        getApprovedPlan: (id) => (nodeRequire('../stores/coworkStore.js') as { getApprovedPlan: AutoResolveDeps['getApprovedPlan'] }).getApprovedPlan(id),
        getAutomation: (id) => automations().getAutomation(id),
        isManaged: isManagedByStage,
        replay: {
            getRun: (id) => automations().getRun(id),
            getRunStepsForChain: (id) => automations().getRunStepsForChain(id),
            getRunFullOutput: (runId, stepId, attempts) => automations().getRunFullOutput(runId, stepId, attempts),
            executeAutomation: (a, o) => (nodeRequire('../core/automationRunner') as { executeAutomation: ReplayRunDeps['executeAutomation'] }).executeAutomation(a, o),
            lookups,
        },
        replayOnRecording: (input, deps) => (nodeRequire('../core/cowork/replay/replayRun.mts') as typeof import('../core/cowork/replay/replayRun.mts')).replayOnRecording(input, deps),
        judge: (automation, item) => proposals().proposalDeps().judge(automation, item),
        approveDefinition: (input) => (nodeRequire('./coworkPlanVersions.mts') as typeof import('./coworkPlanVersions.mts')).approveDefinition(input),
        proposals: (nodeRequire('../stores/coworkProposals.mts') as typeof import('../stores/coworkProposals.mts')).coworkProposals(),
        audit: async (item, fields) => {
            const user = await (nodeRequire('../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(item.userId).catch(() => null);
            await (nodeRequire('./coworkAudit.mts') as typeof import('./coworkAudit.mts')).recordCowork('cowork.plan_auto_fixed', item.id, { userId: AUTO_FIX_APPROVER, organizationId: user?.organizationId ?? null }, fields);
        },
        propose: (item, request, deps) => proposals().propose(item, request, deps),
        proposalDeps: () => proposals().proposalDeps(),
        chooseList: modelChooser(),
        spendLeft: (item) => (nodeRequire('../core/cowork/spendGate.mts') as typeof import('../core/cowork/spendGate.mts')).assertSpendLeft(item),
        rerun: async (item) => {
            const store = nodeRequire('../stores/coworkStore.js') as { getSchedule: (id: string) => Promise<unknown> };
            const fresh = await store.getSchedule(item.id);
            if (fresh) await (nodeRequire('../core/cowork/coworkRunner') as { executeCowork: (s: unknown, o: { manual: boolean }) => Promise<unknown> }).executeCowork(fresh, { manual: true });
        },
        lookups,
    };
}

/** The model's choice among the lists: one short call on the planner's model, booked on the run, paths and titles only. */
function modelChooser(): ChooseList {
    return async ({ item, stepTitle, sourceTitle, missing, lists, bookOn }) => {
        const planner = (nodeRequire('./coworkPlanner.mts') as typeof import('./coworkPlanner.mts')).plannerDeps();
        const user = await (nodeRequire('../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(item.userId);
        const userOrgId = user?.organizationId ?? null;
        const modelId = await planner.resolveModel({ userOrgId, userId: item.userId });
        if (!modelId) return null;
        const ask = [
            `A step titled ${JSON.stringify(stepTitle)} works through a list it reads as ${JSON.stringify(missing)} from the output of the step titled ${JSON.stringify(sourceTitle)}; that output has no such list.`,
            'These are the paths that do hold a list in that output, numbered:',
            ...lists.map((p, i) => `${i}: ${p}`),
            'Answer with the number of the one the step is meant to work through, and nothing else. Answer "none" when none fits.',
        ].join('\n');
        const startedAt = Date.now();
        const response = await planner.chat(modelId, [{ role: 'user', content: ask }], { maxTokens: 16, temperature: 0 });
        planner.logUsage({ source: 'cowork_planner', userId: item.userId, orgId: userOrgId, model: modelId, usage: response.usage, startedAt, runId: bookOn });
        const n = Number.parseInt(String(response.content ?? '').trim(), 10);
        return Number.isInteger(n) && n >= 0 && n < lists.length ? n : null;
    };
}

/** The shape of what the earlier step returned in that run; null when the run kept no output of it. */
async function sourceShapeOf(run: JudgedRun, fact: UnresolvedFact, deps: AutoResolveDeps): Promise<unknown> {
    if (!run.automationRunId) return null;
    const { recordedStepsOf } = nodeRequire('../core/cowork/replay/recordingOf.mts') as typeof import('../core/cowork/replay/recordingOf.mts');
    const source = (await recordedStepsOf(run.automationRunId, deps.replay)).get(fact.sourceStepId);
    return source && source.status === 'success' && source.usable ? shapeOf(source.output) : null;
}

const titleOf = (definition: Definition, id: string, lookups: ToolLookups): string => planViewOf(definition, lookups).steps.find((s) => s.id === id)?.title ?? id;

/** The candidate reference: the deterministic rules first, the model only when they do not answer. */
async function candidateOf(item: ResolveItem, run: JudgedRun, fact: UnresolvedFact, definition: Definition, deps: AutoResolveDeps): Promise<{ ref: string | null; lists: ListPath[] }> {
    const shape = await sourceShapeOf(run, fact, deps);
    if (shape === null) return { ref: null, lists: [] };
    const found = deterministicCandidate(fact, shape);
    if (found.ref !== null) return { ref: found.ref, lists: listPathsOf(shape) };
    if (!deps.chooseList || found.lists.length === 0) return { ref: null, lists: found.lists };
    try { await deps.spendLeft(item); } catch { return { ref: null, lists: found.lists }; }
    const paths = found.lists.map((l) => refOfList(fact.sourceStepId, l));
    const choice = await deps.chooseList({
        item, stepTitle: titleOf(definition, fact.stepId, deps.lookups), sourceTitle: titleOf(definition, fact.sourceStepId, deps.lookups),
        missing: fact.ref, lists: paths, bookOn: run.runId,
    }).catch((e: Error) => { log.warn(`[Cowork] ${item.id}: the model could not choose a list: ${e.message}`); return null; });
    return { ref: choice === null ? null : paths[choice] ?? null, lists: found.lists };
}

/** The run as the replay needs it: its recording, the approved plan it followed, its level and trusted steps. */
function pastOf(run: JudgedRun, approved: Approved): PastRun {
    return { id: run.runId, startedAt: run.startedAt, automationRunId: run.automationRunId, planThen: approved.definition as Definition, independence: null, trustedSteps: [] };
}

/** The replay shows the patch works: the step gets its list, nothing fails, and no reference is left unresolved. */
function replayHolds(steps: Map<string, RecordedStep> | null, patched: Definition, fact: UnresolvedFact, lookups: ToolLookups): boolean {
    if (!steps) return false;
    const own = steps.get(fact.stepId);
    if (!own || own.status !== 'success') return false;
    const iterations = own.output && typeof own.output === 'object' ? (own.output as { iterations?: unknown }).iterations : undefined;
    if (typeof iterations === 'number' && iterations < 1) return false;
    if ([...steps.values()].some((s) => s.status === 'error')) return false;
    return unresolvedOf(patched, steps, lookups).length === 0;
}

/** The fallback: the repair its owner decides, with the patched plan when there is one, else the facts. */
async function fallBack(item: ResolveItem, run: JudgedRun, fact: UnresolvedFact, definition: Definition, patched: Definition | null, lists: ListPath[], deps: AutoResolveDeps): Promise<ResolveOutcome> {
    const stepTitle = titleOf(definition, fact.stepId, deps.lookups);
    const base = deps.proposalDeps();
    const facts = {
        kind: 'reference_unresolved' as const, stepId: fact.stepId, stepTitle, sourceStepId: fact.sourceStepId,
        sourceTitle: titleOf(definition, fact.sourceStepId, deps.lookups), ref: fact.ref, lists: lists.map((l) => refOfList(fact.sourceStepId, l)),
    };
    // A patch that is ready is offered as it is (with what it may newly do); without one, the amend mode works it out from the facts.
    const proposalDeps = patched ? { ...base, amend: async () => ({ definition: patched, summary: '', rounds: 0 }) } : base;
    const outcome = await deps.propose(item, { kind: 'repair', reasonCode: 'reference_unresolved', stepId: fact.stepId, stepTitle, facts, bookOn: run.runId }, proposalDeps)
        .catch((e: Error) => { log.warn(`[Cowork] ${item.id}: no repair of the reference was proposed: ${e.message}`); return 'failed' as const; });
    return outcome === 'proposed' ? 'proposed' : 'not_fixed';
}

/** Apply the patch as a new approved version, leave its record and trail entry, and run a scheduled item again. */
async function apply(item: ResolveItem, run: JudgedRun, fact: UnresolvedFact, approved: Approved, patched: Definition, deps: AutoResolveDeps): Promise<ResolveOutcome> {
    const state = await deps.approveDefinition({ item, definition: patched, approvedBy: AUTO_FIX_APPROVER });
    const fingerprint = planFingerprint(patched);
    await deps.proposals.recordAutoFix({
        id: randomUUID(), scheduleId: item.id, userId: item.userId, kind: 'repair', reasonCode: AUTO_FIX_REASON,
        stepId: fact.stepId, stepTitle: titleOf(patched, fact.stepId, deps.lookups), baseFingerprint: approved.fingerprint,
        definition: patched, fingerprint, widens: [], replayId: null,
    });
    await deps.audit(item, { stepId: fact.stepId, version: state.approved?.version ?? null, fingerprint });
    log.info(`[Cowork] ${item.id}: the reference of step ${fact.stepId} was fixed by itself (run ${run.runId})`);
    if (item.triggerKind && item.triggerKind !== 'schedule') return 'fixed';
    await deps.rerun(item);
    return 'fixed_and_rerun';
}

/** Fix the broken reference of the run `run` of `item`, or propose a repair. */
export async function autoResolve(item: ResolveItem, run: JudgedRun, fact: UnresolvedFact, deps: AutoResolveDeps = autoResolveDeps()): Promise<ResolveOutcome> {
    const approved = await deps.getApprovedPlan(item.id);
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!approved || !automation || approved.id !== run.planId) return 'not_fixed';
    const definition = approved.definition as Definition;
    const { ref, lists } = await candidateOf(item, run, fact, definition, deps);
    const patched = ref ? patchRef(definition, fact, ref) : null;
    if (!ref || !patched) return fallBack(item, run, fact, definition, null, lists, deps);
    if (!sameReach(definition, patched, fact, ref, deps.lookups)) return fallBack(item, run, fact, definition, patched, lists, deps);
    const draft = await deps.judge({ ...automation, definition: patched }, item);
    if (draft.findings.length > 0) return fallBack(item, run, fact, definition, patched, lists, deps);
    const replayed = await deps.replayOnRecording({ item, automation, past: pastOf(run, approved), definition: patched }, deps.replay)
        .catch((e: Error) => { log.warn(`[Cowork] ${item.id}: the fix of the reference was not replayed: ${e.message}`); return null; });
    if (!replayHolds(replayed, patched, fact, deps.lookups)) return fallBack(item, run, fact, definition, patched, lists, deps);
    try {
        return await apply(item, run, fact, approved, patched, deps);
    } catch (e) {
        log.warn(`[Cowork] ${item.id}: the fix of the reference was not applied: ${(e as Error).message}`);
        return fallBack(item, run, fact, definition, patched, lists, deps);
    }
}
