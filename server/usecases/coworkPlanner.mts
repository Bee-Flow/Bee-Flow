/**
 * The Cowork planner: from the brief of an item to a PLAN its owner can look at, try and approve
 * (routes/coworkPlanRoutes.js, which checked the item is the caller's).
 *
 * A model drafts the plan with the automation builder's own tools (the flowlet agent's loop,
 * automation/flowletAgent.js, on the root graph instead of one sub-flow), so the result is an ordinary automation of
 * the owner's: validated like one, stored like one, and open in Studio for anyone who wants to refine it by hand.
 * The item then names it as its plan. Nothing is approved here, and nothing runs: making a plan reads no data and
 * calls no app. The model sees the brief, the names of the owner's connected apps and their inputs, and the reports
 * about its own draft.
 *
 * What keeps the result a plan:
 *   - the menu (./coworkPlannerPrompt.mts) offers only the step types Cowork runs, and a call outside it is refused
 *     before it is carried out;
 *   - after every change the draft is checked twice, by the builder's validation and by Cowork's own rules
 *     (core/cowork/plan/planChecks.mts), and both reports go back to the model to fix;
 *   - whatever the model ends on, the plan card shows the findings of those same rules, and a plan with a finding
 *     cannot be approved, tried or run;
 *   - a draft without findings is TRIED before its owner sees it (./coworkPlannerTry.mts): once in test mode, what
 *     went wrong back to the model as facts, at most three try-outs. The plan arrives with how its try-out went, and
 *     it is approved from its card only once a try-out of exactly that plan passed;
 *   - a draft that was not tried because its wiring is wrong is fixed by Cowork itself when the fix reaches exactly
 *     what the draft reaches (./coworkPlanWiringRepair.mts), and tried once; it still waits for its owner's approval.
 *
 * An item that already has a plan is left alone: its owner takes the plan off first. A draft that came out empty is
 * not stored.
 */

import { createRequire } from 'node:module';
import { asStartedBy } from '../core/cowork/startKinds.mts';
import { briefForPlanner } from '../core/cowork/taskSetup.mts';
import type { TaskSetup } from '../stores/coworkSetup.mts';
import type { Definition, PlanFinding } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { draftFindings, refFindings } from './coworkPlanRefs.mts';
import { tryAndRepair, type TriedPlan, type TryProgress, type TryRoundDeps } from './coworkPlannerTry.mts';
import type { SourceRow } from '../core/cowork/plan/planSource.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { plannerChat } from './coworkPlannerChat.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { plannerRefusal, plannerSystemPrompt, plannerTools } from './coworkPlannerPrompt.mts';
import { builderPort, draftWithin, newDraft, type DraftWrap, type LoopDeps, type LoopResult, type Message } from './coworkDraftLoop.mts';
import type { Repaired } from './coworkPlanWiringRepair.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (msg: string) => void };

/** The real builder and the draft the planner works on live in ./coworkDraftLoop.mts. */
export { builderPort, type BuilderPort, type DraftWrap } from './coworkDraftLoop.mts';

/** Rounds of model and tools before the planner stops with what it has. */
export const MAX_PLANNER_ROUNDS = 8;
/** The whole making of a plan, in ms. */
export const PLANNER_MAX_MS = 180_000;

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null; triggerKind?: string | null; planAutomationId?: string | null; monthlyBudget?: number | null; enabledApps?: string[] | null; setup?: Pick<TaskSetup, 'sendsTo'> | null }

export interface PlannerDeps extends LoopDeps {
    store: { attachPlanAutomation: (scheduleId: string, automationId: string, opts?: { onlyIfNone?: boolean }) => Promise<boolean> };
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    /** The model the planner thinks with, or null when the workspace has none. */
    resolveModel: (who: { userOrgId: string | null; userId: string }) => Promise<string | null>;
    /** The owner's licence covers a step that waits for a decision (core/cowork/plan/planLicence.mts). */
    mayAsk: MayAsk;
    /** The try-out of every draft (./coworkPlannerTry.mts); without it the draft is not tried. */
    tries?: Pick<TryRoundDeps, 'tryOut' | 'getAutomation' | 'spendLeft' | 'recordTry'>;
    /**
     * Cowork's own fix of the wiring of a draft it could not try because of it (./coworkPlanWiringRepair.mts): fixed,
     * stored, tried. Without it a miswired draft stays as the model left it.
     */
    repairWiring?: (item: Item) => Promise<Repaired | null>;
}

/** The real wiring of the planner (the amend mode, ./coworkPlanAmend.mts, thinks the same way). */
export function plannerDeps(): PlannerDeps {
    const flowlet = () => nodeRequire('../automation/flowletAgent.js') as { resolveLayerAgentModel: PlannerDeps['resolveModel'] };
    return {
        store: nodeRequire('../stores/coworkStore.js') as PlannerDeps['store'],
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: PlannerDeps['ownerRefusal'] }).ownerRefusal(owner),
        // The model a sub-agent of the builder thinks with: the thinking tier, else the fast one.
        resolveModel: (who) => flowlet().resolveLayerAgentModel(who),
        tiersFor: (who) => (nodeRequire('../core/llm/modelResolver.js') as { getUserTierMap: PlannerDeps['tiersFor'] }).getUserTierMap(who),
        chat: (modelId, messages, options) => plannerChat(modelId, messages, options),
        logUsage: (call) => (nodeRequire('../core/llm/surfaceUsage.js') as { logSurfaceUsage: (c: unknown) => void }).logSurfaceUsage(call),
        builder: builderPort(),
        lookups: toolLookups(),
        mayAsk: mayAskByLicence,
        now: () => Date.now(),
        maxMs: PLANNER_MAX_MS,
        tries: {
            tryOut: (input) => (nodeRequire('./coworkPlanTryOut.mts') as typeof import('./coworkPlanTryOut.mts')).tryDefinition(input),
            getAutomation: (id) => (nodeRequire('../stores/automationStore') as { getAutomation: (id: string) => Promise<SourceRow | null> }).getAutomation(id),
            spendLeft: (item) => (nodeRequire('../core/cowork/spendGate.mts') as typeof import('../core/cowork/spendGate.mts')).assertSpendLeft(item),
            recordTry: (id, record) => (nodeRequire('./coworkPlanTryOut.mts') as typeof import('./coworkPlanTryOut.mts')).planTries().setPlanTry(id, record),
        },
        repairWiring: (item) => (nodeRequire('./coworkPlanWiringRepair.mts') as typeof import('./coworkPlanWiringRepair.mts')).repairQuietly(item),
    };
}

/** What the page is told while a plan is being made: the drafting, then the try-outs and their repairs. */
export type PlannerProgress = TryProgress;

export interface MakeInput {
    item: Item;
    /** Result of this request's server-side preflight, when checked before opening the stream. */
    prepared?: { brief: string; modelId: string };
    /** The caller's session: which apps they have connected is read through it. */
    session?: unknown;
    userOrgId?: string | null;
    signal?: AbortSignal | null;
    onProgress?: (progress: PlannerProgress) => void;
    /** What the item's past runs did (usecases/coworkRoutine.mts): "make it routine". */
    hints?: string | null;
}

export interface MadePlan {
    automationId: string;
    /** What the model said the plan does, and what it could not do. */
    summary: string;
    /** Why the plan may not run as it is; empty for a plan that can be tried and approved. */
    findings: PlanFinding[];
    rounds: number;
    /** How its try-outs went; absent when the planner does not try (a test's planner). */
    tried?: TriedPlan;
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/**
 * The brief of an item that may get a plan made for it; throws the reason when it may not. What its owner chose on
 * the confirmation closes it (core/cowork/taskSetup.mts): the apps to build with, and who it sends to as its last
 * line, so the plan is drafted for exactly them.
 */
function briefOf(item: Item): string {
    if (item.planAutomationId) throw new HttpError(409, 'cowork_plan_refused', 'This item already has a plan. Take it off to make a new one.');
    const brief = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!brief) throw new HttpError(422, 'cowork_plan_refused', 'Write what this work should do first: a plan is made from that.');
    return briefForPlanner(brief, item);
}

/**
 * May a plan be made for this item now? Answers the brief and the model it would be made with; throws the reason when
 * not. The route asks this before it opens its stream, so a refusal is an ordinary answer with its status.
 */
export async function readyToPlan({ item, userOrgId = null }: Pick<MakeInput, 'item' | 'userOrgId'>, deps: PlannerDeps = plannerDeps()): Promise<{ brief: string; modelId: string }> {
    const brief = briefOf(item);
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: userOrgId });
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', REFUSAL_TEXT[refusal]);
    const modelId = await deps.resolveModel({ userOrgId, userId: item.userId });
    if (!modelId) throw new HttpError(409, 'cowork_planner_no_model', 'No AI model is configured for this workspace, so a plan cannot be made yet.');
    return { brief, modelId };
}

/** Store the draft as an automation of its owner's and name it as the item's plan; answers the automation's id. */
async function storeAsPlan(item: Item, draft: DraftWrap, deps: PlannerDeps): Promise<string> {
    const stored = await deps.builder.persistDraft(draft, { finalize: true });
    const automationId = stored?.id ?? draft.automationId;
    if (!automationId || stored?.error) throw new Error(`the planner could not store its draft: ${stored?.error ?? 'no automation id'}`);
    // Only onto an item that still has no plan: a second making at the same time does not replace the first.
    if (!(await deps.store.attachPlanAutomation(item.id, automationId, { onlyIfNone: true }))) {
        throw new HttpError(409, 'cowork_plan_refused', 'This item got a plan while this one was being made. The new draft is kept among your automations.');
    }
    return automationId;
}

/** Make the plan of an item from its brief, store it as an automation of its owner's, and name it as the item's plan. */
export async function makePlan(input: MakeInput, deps: PlannerDeps = plannerDeps()): Promise<MadePlan> {
    const { item } = input;
    const userOrgId = input.userOrgId ?? null;
    const { brief, modelId } = input.prepared ?? await readyToPlan({ item, userOrgId }, deps);

    const owner = { userId: item.userId, organizationId: userOrgId };
    const [catalog, approvals] = await Promise.all([
        deps.builder.catalogFor(item.userId, input.session ?? null),
        deps.mayAsk(owner),
    ]);
    const draft = await newDraft({
        userId: item.userId, userOrgId, catalog,
        // Its own prefix, so a plan Cowork drafted is recognisable next to the builder's `bs_` sessions.
        sessionId: `cw_${item.id}_${deps.now().toString(36)}`,
        title: item.title || 'Cowork plan', description: 'Drafted by Cowork from the brief of this item.',
    }, deps);
    // What Cowork would not run, the licence included: what is returned and what stops a try-out. The model is also told
    // the advice (a read that no step uses).
    const blockingOf = async (def: Definition) => [...checkPlan(asStartedBy(def, item), deps.lookups), ...refFindings(def, deps.lookups), ...await licenceFindings(def, owner, async () => approvals)];
    const findingsOf = async (def: Definition) => [...checkPlan(asStartedBy(def, item), deps.lookups), ...draftFindings(def, deps.lookups), ...await licenceFindings(def, owner, async () => approvals)];
    const system = plannerSystemPrompt({
        title: draft.title, brief, approvals, hints: input.hints ?? null, startsOnMail: item.triggerKind === 'app_event',
        catalog: deps.builder.renderCatalog(catalog),
        datatables: deps.builder.renderDatatables(catalog.datatables),
    });
    const menu = { tools: plannerTools(deps.builder.toolSchemas), refusal: plannerRefusal };
    const ask = 'Make the plan for this work.';
    const messages: Message[] = [{ role: 'system', content: system }, { role: 'user', content: ask }];
    const spec = { draft, modelId, system, ask, menu, findingsOf, onProgress: input.onProgress, messages };
    const loop: LoopResult = await draftWithin(
        { ...spec, maxRounds: MAX_PLANNER_ROUNDS },
        input.signal, { code: 'cowork_planner_timeout', message: 'Making the plan took too long. Try again, or write a shorter brief.' }, deps,
    );

    const steps = planViewOf(draft.def, deps.lookups).steps;
    if (steps.length === 0) {
        throw new HttpError(422, 'cowork_planner_empty', loop.summary ? `No plan could be made for this brief. ${loop.summary}` : 'No plan could be made for this brief. Try describing the work step by step.');
    }
    input.onProgress?.({ phase: 'saving' });
    const automationId = await storeAsPlan(item, draft, deps);
    log.info(`[CoworkPlanner] ${item.id}: drafted ${steps.length} step(s) in ${loop.rounds} round(s) as automation ${automationId}`);
    const tried = deps.tries ? await tryAndRepair({ item, draft, automationId, loop: spec, blockingOf, signal: input.signal, onProgress: input.onProgress }, { ...deps, ...deps.tries }) : undefined;
    if (tried) log.info(`[CoworkPlanner] ${item.id}: ${tried.status} after ${tried.rounds} try-out(s)`);
    const outcome = await afterTries({ ...item, planAutomationId: automationId }, await blockingOf(draft.def), tried, deps);
    return { automationId, summary: loop.summary, rounds: loop.rounds, ...outcome };
}

/**
 * A draft its try-outs never reached because of a finding: Cowork fixes its wiring by itself when it can, and tries it
 * once (./coworkPlanWiringRepair.mts). A draft that was tried is not tried again.
 */
async function afterTries(item: Item, findings: PlanFinding[], tried: TriedPlan | undefined, deps: PlannerDeps): Promise<Pick<MadePlan, 'findings' | 'tried'>> {
    const untried = !!tried && tried.status !== 'passed' && tried.status !== 'failed';
    const repaired = untried && findings.length > 0 && deps.repairWiring ? await deps.repairWiring(item) : null;
    if (!tried || repaired?.outcome !== 'fixed') return { findings, ...(tried ? { tried } : {}) };
    return { findings: [], tried: { status: repaired.tried ?? 'untried', summary: null, problems: repaired.notTried ? [repaired.notTried] : [], rounds: tried.rounds } };
}
