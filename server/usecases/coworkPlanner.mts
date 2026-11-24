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
 *     cannot be approved, tried or run.
 *
 * An item that already has a plan is left alone: its owner takes the plan off first. A draft that came out empty is
 * not stored.
 */

import { createRequire } from 'node:module';
import { asStartedBy } from '../core/cowork/startKinds.mts';
import type { Definition, PlanFinding } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { plannerChat } from './coworkPlannerChat.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { plannerRefusal, plannerSystemPrompt, plannerTools } from './coworkPlannerPrompt.mts';
import { builderPort, draftWithin, newDraft, type DraftProgress, type DraftWrap, type LoopDeps, type LoopResult } from './coworkDraftLoop.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (msg: string) => void };

/** The real builder and the draft the planner works on live in ./coworkDraftLoop.mts. */
export { builderPort, type BuilderPort, type DraftWrap } from './coworkDraftLoop.mts';

/** Rounds of model and tools before the planner stops with what it has. */
export const MAX_PLANNER_ROUNDS = 8;
/** The whole making of a plan, in ms. */
export const PLANNER_MAX_MS = 180_000;

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null; triggerKind?: string | null; planAutomationId?: string | null }

export interface PlannerDeps extends LoopDeps {
    store: { attachPlanAutomation: (scheduleId: string, automationId: string, opts?: { onlyIfNone?: boolean }) => Promise<boolean> };
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    /** The model the planner thinks with, or null when the workspace has none. */
    resolveModel: (who: { userOrgId: string | null; userId: string }) => Promise<string | null>;
    /** The owner's licence covers a step that waits for a decision (core/cowork/plan/planLicence.mts). */
    mayAsk: MayAsk;
}

function defaultDeps(): PlannerDeps {
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
    };
}

/** What the page is told while a plan is being made. */
export type PlannerProgress = DraftProgress;

export interface MakeInput {
    item: Item;
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
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/** The brief of an item that may get a plan made for it; throws the reason when it may not. */
function briefOf(item: Item): string {
    if (item.triggerKind === 'app_event') throw new HttpError(409, 'cowork_plan_refused', 'An item that starts on a new mail cannot carry a plan yet.');
    if (item.planAutomationId) throw new HttpError(409, 'cowork_plan_refused', 'This item already has a plan. Take it off to make a new one.');
    const brief = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!brief) throw new HttpError(422, 'cowork_plan_refused', 'Write what this work should do first: a plan is made from that.');
    return brief;
}

/**
 * May a plan be made for this item now? Answers the brief and the model it would be made with; throws the reason when
 * not. The route asks this before it opens its stream, so a refusal is an ordinary answer with its status.
 */
export async function readyToPlan({ item, userOrgId = null }: Pick<MakeInput, 'item' | 'userOrgId'>, deps: PlannerDeps = defaultDeps()): Promise<{ brief: string; modelId: string }> {
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
export async function makePlan(input: MakeInput, deps: PlannerDeps = defaultDeps()): Promise<MadePlan> {
    const { item } = input;
    const userOrgId = input.userOrgId ?? null;
    const { brief, modelId } = await readyToPlan({ item, userOrgId }, deps);

    const catalog = await deps.builder.catalogFor(item.userId, input.session ?? null);
    const draft = await newDraft({
        userId: item.userId, userOrgId, catalog,
        // Its own prefix, so a plan Cowork drafted is recognisable next to the builder's `bs_` sessions.
        sessionId: `cw_${item.id}_${deps.now().toString(36)}`,
        title: item.title || 'Cowork plan', description: 'Drafted by Cowork from the brief of this item.',
    }, deps);
    const owner = { userId: item.userId, organizationId: userOrgId };
    const approvals = await deps.mayAsk(owner);
    // What Cowork would not run, the licence included: what the model is told after each change, and what is returned.
    const findingsOf = async (def: Definition) => [...checkPlan(asStartedBy(def, item), deps.lookups), ...await licenceFindings(def, owner, async () => approvals)];
    const system = plannerSystemPrompt({
        title: draft.title, brief, approvals, hints: input.hints ?? null,
        catalog: deps.builder.renderCatalog(catalog),
        datatables: deps.builder.renderDatatables(catalog.datatables),
    });
    const menu = { tools: plannerTools(deps.builder.toolSchemas), refusal: plannerRefusal };
    const loop: LoopResult = await draftWithin(
        { draft, modelId, system, ask: 'Make the plan for this work.', menu, maxRounds: MAX_PLANNER_ROUNDS, findingsOf, onProgress: input.onProgress },
        input.signal, { code: 'cowork_planner_timeout', message: 'Making the plan took too long. Try again, or write a shorter brief.' }, deps,
    );

    const steps = planViewOf(draft.def, deps.lookups).steps;
    if (steps.length === 0) {
        throw new HttpError(422, 'cowork_planner_empty', loop.summary ? `No plan could be made for this brief. ${loop.summary}` : 'No plan could be made for this brief. Try describing the work step by step.');
    }
    input.onProgress?.({ phase: 'saving' });
    const automationId = await storeAsPlan(item, draft, deps);
    log.info(`[CoworkPlanner] ${item.id}: drafted ${steps.length} step(s) in ${loop.rounds} round(s) as automation ${automationId}`);
    return { automationId, summary: loop.summary, findings: await findingsOf(draft.def), rounds: loop.rounds };
}
