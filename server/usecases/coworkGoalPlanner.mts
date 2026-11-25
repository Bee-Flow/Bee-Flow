/**
 * The goal planner: from the goal sentence of a Cowork item to a CHECK its owner can read and approve
 * (./coworkGoals.mts, which checked the item is the caller's).
 *
 * The check is drafted the way a plan is (./coworkDraftLoop.mts): a model builds it with the automation builder's own
 * tools, the result is an ordinary automation of the owner's (open in Studio for anyone who wants to refine it), and
 * the goal names it as its check. The menu is read-only (./coworkGoalPlannerPrompt.mts): only fixed steps that read,
 * keep and count. After every change the draft is held to the rules of a check (core/cowork/goals/goalCheck.mts) and
 * the findings go back to the model to fix.
 *
 * Nothing is approved here and nothing runs: drafting a check reads no data and calls no app. A new check replaces
 * the one before, and is not approved until its owner approves it.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding } from '../core/cowork/plan/planTypes.mts';
import type { CoworkGoalsStore } from '../stores/coworkGoals.mts';
import { goalCheckFindings } from '../core/cowork/goals/goalCheck.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { plannerChat } from './coworkPlannerChat.mts';
import { toolMenu } from './coworkPlannerPrompt.mts';
import { goalMayAdd, goalRefusal, goalSystemPrompt } from './coworkGoalPlannerPrompt.mts';
import { builderPort, draftWithin, newDraft, type Catalog, type DraftWrap, type LoopDeps } from './coworkDraftLoop.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (msg: string) => void };

/** Rounds of model and tools before the goal planner stops with what it has. */
export const MAX_GOAL_ROUNDS = 8;
/** The whole drafting of a check, in ms: the answer is one request, not a stream. */
export const GOAL_PLANNER_MAX_MS = 120_000;

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null }

export interface GoalPlannerDeps extends LoopDeps {
    store: Pick<CoworkGoalsStore, 'setCheck'>;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    /** The model the planner thinks with, or null when the workspace has none. */
    resolveModel: (who: { userOrgId: string | null; userId: string }) => Promise<string | null>;
}

function defaultDeps(): GoalPlannerDeps {
    const flowlet = () => nodeRequire('../automation/flowletAgent.js') as { resolveLayerAgentModel: GoalPlannerDeps['resolveModel'] };
    return {
        store: (nodeRequire('../stores/coworkGoals.mts') as typeof import('../stores/coworkGoals.mts')).coworkGoals(),
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: GoalPlannerDeps['ownerRefusal'] }).ownerRefusal(owner),
        resolveModel: (who) => flowlet().resolveLayerAgentModel(who),
        tiersFor: (who) => (nodeRequire('../core/llm/modelResolver.js') as { getUserTierMap: GoalPlannerDeps['tiersFor'] }).getUserTierMap(who),
        chat: (modelId, messages, options) => plannerChat(modelId, messages, options),
        logUsage: (call) => (nodeRequire('../core/llm/surfaceUsage.js') as { logSurfaceUsage: (c: unknown) => void }).logSurfaceUsage(call),
        builder: builderPort(),
        lookups: toolLookups(),
        now: () => Date.now(),
        maxMs: GOAL_PLANNER_MAX_MS,
    };
}

export interface DraftCheckInput {
    item: Item;
    goal: { sentence: string; targetPercent: number };
    /** The caller's session: which apps they have connected is read through it. */
    session?: unknown;
    userOrgId?: string | null;
    signal?: AbortSignal | null;
}

export interface DraftedCheck {
    automationId: string;
    /** What the model said the check counts, and what it could not count. */
    summary: string;
    /** Why the check may not measure the goal as it is; empty for a check that can be approved. */
    findings: PlanFinding[];
    rounds: number;
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a check.',
    not_entitled: 'A goal\'s check runs on the automation engine, and your organisation does not have automations.',
});

/** May a check be drafted for this goal now? Answers the model it would be drafted with; throws the reason when not. */
async function readyToDraft(input: DraftCheckInput, deps: GoalPlannerDeps): Promise<string> {
    if (!input.goal.sentence.trim()) throw new HttpError(422, 'cowork_goal_refused', 'Write the goal first: the check is drafted from it.');
    const userOrgId = input.userOrgId ?? null;
    const refusal = await deps.ownerRefusal({ userId: input.item.userId, organizationId: userOrgId });
    if (refusal) throw new HttpError(403, 'cowork_goal_refused', REFUSAL_TEXT[refusal]);
    const modelId = await deps.resolveModel({ userOrgId, userId: input.item.userId });
    if (!modelId) throw new HttpError(409, 'cowork_planner_no_model', 'No AI model is configured for this workspace, so a check cannot be drafted yet.');
    return modelId;
}

/** The system prompt of a check for this goal, with the owner's catalog. */
function systemOf(item: Item, goal: DraftCheckInput['goal'], catalog: Catalog, deps: GoalPlannerDeps): string {
    return goalSystemPrompt({
        title: item.title || 'Untitled work', brief: typeof item.prompt === 'string' ? item.prompt.trim() : '',
        sentence: goal.sentence.trim(), targetPercent: goal.targetPercent,
        catalog: deps.builder.renderCatalog(catalog), datatables: deps.builder.renderDatatables(catalog.datatables),
    });
}

/** Store the draft as an automation of its owner's and name it as the goal's check; answers the automation's id. */
async function storeAsCheck(item: Item, draft: DraftWrap, deps: GoalPlannerDeps): Promise<string> {
    const stored = await deps.builder.persistDraft(draft, { finalize: true });
    const automationId = stored?.id ?? draft.automationId;
    if (!automationId || stored?.error) throw new Error(`the goal planner could not store its draft: ${stored?.error ?? 'no automation id'}`);
    if (!(await deps.store.setCheck(item.id, automationId))) {
        throw new HttpError(409, 'cowork_goal_refused', 'This goal was taken off while its check was drafted. The draft is kept among your automations.');
    }
    return automationId;
}

/** Draft the check of an item's goal, store it as an automation of its owner's, and name it as the goal's check. */
export async function draftGoalCheck(input: DraftCheckInput, deps: GoalPlannerDeps = defaultDeps()): Promise<DraftedCheck> {
    const { item } = input;
    const userOrgId = input.userOrgId ?? null;
    const modelId = await readyToDraft(input, deps);
    const catalog = await deps.builder.catalogFor(item.userId, input.session ?? null);
    const draft = await newDraft({
        userId: item.userId, userOrgId, catalog,
        sessionId: `cwg_${item.id}_${deps.now().toString(36)}`,
        title: `Goal check: ${item.title || 'Cowork'}`, description: 'Drafted by Cowork from the goal of this item. It only reads and counts.',
    }, deps);
    const findingsOf = async (def: Definition) => goalCheckFindings(def, deps.lookups);
    const menu = { tools: toolMenu(deps.builder.toolSchemas, goalMayAdd), refusal: goalRefusal };
    const loop = await draftWithin(
        { draft, modelId, system: systemOf(item, input.goal, catalog, deps), ask: 'Make the check for this goal.', menu, maxRounds: MAX_GOAL_ROUNDS, findingsOf },
        input.signal, { code: 'cowork_goal_check_timeout', message: 'Drafting the check took too long. Try again, or write a shorter goal.' }, deps,
    );
    const steps = planViewOf(draft.def, deps.lookups).steps;
    if (steps.length === 0) {
        throw new HttpError(422, 'cowork_goal_check_empty', loop.summary ? `No check could be drafted for this goal. ${loop.summary}` : 'No check could be drafted for this goal. Try saying what should be counted.');
    }
    const automationId = await storeAsCheck(item, draft, deps);
    log.info(`[CoworkGoals] ${item.id}: drafted a check of ${steps.length} step(s) in ${loop.rounds} round(s) as automation ${automationId}`);
    return { automationId, summary: loop.summary, findings: await findingsOf(draft.def), rounds: loop.rounds };
}
