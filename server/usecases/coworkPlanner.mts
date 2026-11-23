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
import type { Definition, PlanFinding, PlanStep, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { plannerChat } from './coworkPlannerChat.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { planReport, plannerRefusal, plannerSystemPrompt, plannerTools, type ValidationRecord } from './coworkPlannerPrompt.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { info: (msg: string) => void; warn: (msg: string) => void };

/** Rounds of model and tools before the planner stops with what it has. */
export const MAX_PLANNER_ROUNDS = 8;
/** The whole making of a plan, in ms. */
export const PLANNER_MAX_MS = 180_000;

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null; triggerKind?: string | null; planAutomationId?: string | null }

type Schema = { type?: string; function?: { name?: string; [key: string]: unknown }; [key: string]: unknown };
interface ToolCall { id: string; function: { name: string; arguments?: unknown }; [key: string]: unknown }
interface ChatResponse { content?: string | null; toolCalls?: ToolCall[] | null; usage?: unknown }
type Message = Record<string, unknown>;

/** The draft the builder's tools work on (automation/mcpBuilder.js McpDraftWrap, the fields set here). */
export interface DraftWrap {
    userId: string;
    orgId: string | null;
    automationId: string | null;
    builderSessionId: string;
    title: string;
    description: string;
    def: Definition;
    [key: string]: unknown;
}

interface Catalog { toolNames?: unknown; datatables?: unknown; [key: string]: unknown }

/** The automation builder, as far as the planner uses it. */
export interface BuilderPort {
    toolSchemas: Schema[];
    mutatingTools: ReadonlySet<string>;
    emptyDefinition: () => Definition;
    applyToolCall: (name: string, args: Record<string, unknown>, draft: DraftWrap) => Promise<unknown>;
    /** The builder's own validation of a definition: its errors. */
    errorsOf: (def: Definition) => ValidationRecord[];
    persistDraft: (draft: DraftWrap, opts: { finalize: boolean }) => Promise<{ id?: string; error?: string } | null>;
    catalogFor: (userId: string, session: unknown) => Promise<Catalog>;
    datatablesFor: (userId: string) => Promise<unknown>;
    inputSchemasByTool: (catalog: Catalog) => Record<string, unknown>;
    renderCatalog: (catalog: Catalog) => string;
    renderDatatables: (datatables: unknown) => string;
    resultText: (result: unknown) => string;
}

export interface PlannerDeps {
    store: { attachPlanAutomation: (scheduleId: string, automationId: string, opts?: { onlyIfNone?: boolean }) => Promise<boolean> };
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    /** The model the planner thinks with, or null when the workspace has none. */
    resolveModel: (who: { userOrgId: string | null; userId: string }) => Promise<string | null>;
    /** The model tiers this person may name in an AI step. */
    tiersFor: (who: { userOrgId: string | null; userId: string }) => Promise<Record<string, unknown>>;
    chat: (modelId: string, messages: Message[], options: Record<string, unknown>) => Promise<ChatResponse>;
    logUsage: (call: Record<string, unknown>) => void;
    builder: BuilderPort;
    lookups: ToolLookups;
    /** The owner's licence covers a step that waits for a decision (core/cowork/plan/planLicence.mts). */
    mayAsk: MayAsk;
    now: () => number;
    /** The whole making of a plan may take this long (PLANNER_MAX_MS). */
    maxMs: number;
}

/** The real builder. A test keeps its tools and validation and hands in what would read the database. */
export function builderPort(): BuilderPort {
    const tools = () => nodeRequire('../automation/builderTools.js') as {
        TOOL_SCHEMAS: Schema[]; MUTATING_TOOLS: Set<string>; emptyDefinition: () => Definition;
        applyToolCall: BuilderPort['applyToolCall']; persistDraft: BuilderPort['persistDraft']; truncateToolResultJson: (r: unknown) => string;
    };
    const render = () => nodeRequire('../automation/builderPrompt/catalogRender.js') as {
        renderCatalogSlim: (c: Catalog) => string; emptyCatalogLine: (c: Catalog) => string; renderDatatablesBlock: (d: unknown) => string;
    };
    return {
        toolSchemas: tools().TOOL_SCHEMAS,
        mutatingTools: tools().MUTATING_TOOLS,
        emptyDefinition: () => tools().emptyDefinition(),
        applyToolCall: (name, args, draft) => tools().applyToolCall(name, args, draft),
        persistDraft: (draft, opts) => tools().persistDraft(draft, opts),
        errorsOf: (def) => {
            const { validateDefinition } = nodeRequire('../automation/validate.js') as { validateDefinition: (d: unknown, o: unknown) => { errors?: ValidationRecord[] } };
            const { getDeliverableEvents } = nodeRequire('../automation/deliverableEvents.js') as { getDeliverableEvents: () => unknown };
            return validateDefinition(def, { deliverableEvents: getDeliverableEvents() }).errors ?? [];
        },
        catalogFor: (userId, session) => (nodeRequire('../automation/builderCatalog.js') as { buildCatalogForUser: BuilderPort['catalogFor'] }).buildCatalogForUser(userId, session),
        datatablesFor: (userId) => (nodeRequire('../automation/builderDatatableCatalog.js') as { buildDatatableCatalogForUser: BuilderPort['datatablesFor'] }).buildDatatableCatalogForUser(userId),
        inputSchemasByTool: (catalog) => (nodeRequire('../automation/builderCatalog.js') as { inputSchemasByTool: BuilderPort['inputSchemasByTool'] }).inputSchemasByTool(catalog),
        renderCatalog: (catalog) => render().renderCatalogSlim(catalog) || render().emptyCatalogLine(catalog),
        renderDatatables: (datatables) => render().renderDatatablesBlock(datatables),
        resultText: (result) => (typeof result === 'string' ? result : tools().truncateToolResultJson(result)),
    };
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
export type PlannerProgress =
    | { phase: 'thinking'; round: number }
    | { phase: 'drafted'; round: number; steps: Array<Pick<PlanStep, 'id' | 'title' | 'kind'>> }
    | { phase: 'saving' };

export interface MakeInput {
    item: Item;
    /** The caller's session: which apps they have connected is read through it. */
    session?: unknown;
    userOrgId?: string | null;
    signal?: AbortSignal | null;
    onProgress?: (progress: PlannerProgress) => void;
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

const TITLE_MAX = 120;

async function newDraft(item: Item, userOrgId: string | null, catalog: Catalog, deps: PlannerDeps): Promise<DraftWrap> {
    const who = { userOrgId, userId: item.userId };
    const tiers = await deps.tiersFor(who);
    let datatables: unknown = null;
    try { datatables = await deps.builder.datatablesFor(item.userId); } catch (e) { log.warn(`[CoworkPlanner] datatable catalog unavailable: ${(e as Error).message}`); }
    catalog.datatables = datatables;
    return {
        userId: item.userId,
        orgId: userOrgId,
        automationId: null,
        // Its own prefix, so a plan Cowork drafted is recognisable next to the builder's `bs_` sessions.
        builderSessionId: `cw_${item.id}_${deps.now().toString(36)}`,
        title: (item.title || 'Cowork plan').slice(0, TITLE_MAX),
        description: 'Drafted by Cowork from the brief of this item.',
        def: deps.builder.emptyDefinition(),
        _datatables: datatables,
        _inputSchemasByTool: deps.builder.inputSchemasByTool(catalog),
        _availableToolNames: catalog.toolNames instanceof Set ? catalog.toolNames : null,
        _inspectedTools: new Set<string>(),
        // An AI step may only name a tier its owner has; an unreadable tier map threw above.
        _allowedModelTiers: new Set(['auto', ...Object.keys(tiers).filter((k) => k !== 'swarm' && k !== 'standard')]),
    };
}

function argsOf(call: ToolCall): Record<string, unknown> {
    const raw = call.function.arguments;
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    } catch { return {}; }
}

/** The assistant turn as the next request carries it (the flowlet agent's shape, provider extras kept). */
function assistantMessage(response: ChatResponse): Message {
    return {
        role: 'assistant',
        content: response.content || null,
        tool_calls: (response.toolCalls ?? []).map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}) },
            _thought_signature: tc._thought_signature || undefined,
            _raw_content_parts: tc._raw_content_parts || undefined,
        })),
    };
}

/** Carry out one tool call of the model on the draft, or refuse it; answers what the model is told. */
async function runTool(call: ToolCall, draft: DraftWrap, builder: BuilderPort): Promise<{ result: unknown; mutated: boolean }> {
    const name = call.function.name;
    const args = argsOf(call);
    const refusal = plannerRefusal(name, args);
    if (refusal) return { result: { error: refusal }, mutated: false };
    // A plan is one list of steps: every call works on the root graph.
    delete args.scope;
    let result: unknown;
    try { result = await builder.applyToolCall(name, args, draft); } catch (e) { result = { error: (e as Error).message }; }
    const failed = !!result && typeof result === 'object' && 'error' in result && !!(result as { error?: unknown }).error;
    return { result, mutated: builder.mutatingTools.has(name) && !failed };
}

interface LoopResult { summary: string; rounds: number }

interface LoopInput { draft: DraftWrap; modelId: string; system: string; signal: AbortSignal; findingsOf: (def: Definition) => Promise<PlanFinding[]>; onProgress?: MakeInput['onProgress'] }

/** The model and its tools, until the model stops, the rounds are used up or the caller gave up. */
async function draftLoop({ draft, modelId, system, signal, findingsOf, onProgress }: LoopInput, deps: PlannerDeps): Promise<LoopResult> {
    const { builder } = deps;
    const tools = plannerTools(builder.toolSchemas);
    const messages: Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Make the plan for this work.' },
    ];
    let summary = '';
    let rounds = 0;
    for (let round = 0; round < MAX_PLANNER_ROUNDS; round++) {
        signal.throwIfAborted();
        rounds = round + 1;
        onProgress?.({ phase: 'thinking', round });
        const startedAt = deps.now();
        const response = await deps.chat(modelId, messages, { signal, maxTokens: 8192, temperature: 0.2, tools, toolChoice: 'auto', reasoningEffort: 'medium' });
        deps.logUsage({ source: 'cowork_planner', userId: draft.userId, orgId: draft.orgId, model: modelId, usage: response.usage, startedAt, conversationId: draft.builderSessionId });
        if (response.content) summary = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) break;

        messages.push(assistantMessage(response));
        let mutated = false;
        for (const call of response.toolCalls) {
            const done = await runTool(call, draft, builder);
            mutated = mutated || done.mutated;
            messages.push({ role: 'tool', tool_call_id: call.id, content: builder.resultText(done.result) });
        }
        if (!mutated) continue;
        onProgress?.({ phase: 'drafted', round, steps: planViewOf(draft.def, deps.lookups).steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind })) });
        const report = planReport(builder.errorsOf(draft.def), await findingsOf(draft.def));
        if (report) messages.push({ role: 'user', content: report });
    }
    return { summary: summary.trim(), rounds };
}

/** The caller's signal and the planner's own time limit, as one. */
function limited(signal: AbortSignal | null | undefined, maxMs: number): AbortSignal {
    const limit = AbortSignal.timeout(maxMs);
    return signal ? AbortSignal.any([signal, limit]) : limit;
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

/** The draft loop under the planner's time limit: past it the caller hears so, in words. */
async function draftWithin(loop: Omit<LoopInput, 'signal'>, callerSignal: AbortSignal | null | undefined, deps: PlannerDeps): Promise<LoopResult> {
    const signal = limited(callerSignal, deps.maxMs);
    try {
        return await draftLoop({ ...loop, signal }, deps);
    } catch (e) {
        if (signal.aborted && !callerSignal?.aborted) throw new HttpError(504, 'cowork_planner_timeout', 'Making the plan took too long. Try again, or write a shorter brief.');
        throw e;
    }
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
    const draft = await newDraft(item, userOrgId, catalog, deps);
    const owner = { userId: item.userId, organizationId: userOrgId };
    const approvals = await deps.mayAsk(owner);
    // What Cowork would not run, the licence included: what the model is told after each change, and what is returned.
    const findingsOf = async (def: Definition) => [...checkPlan(def, deps.lookups), ...await licenceFindings(def, owner, async () => approvals)];
    const system = plannerSystemPrompt({
        title: draft.title, brief, approvals,
        catalog: deps.builder.renderCatalog(catalog),
        datatables: deps.builder.renderDatatables(catalog.datatables),
    });
    const loop = await draftWithin({ draft, modelId, system, findingsOf, onProgress: input.onProgress }, input.signal, deps);

    const steps = planViewOf(draft.def, deps.lookups).steps;
    if (steps.length === 0) {
        throw new HttpError(422, 'cowork_planner_empty', loop.summary ? `No plan could be made for this brief. ${loop.summary}` : 'No plan could be made for this brief. Try describing the work step by step.');
    }
    input.onProgress?.({ phase: 'saving' });
    const automationId = await storeAsPlan(item, draft, deps);
    log.info(`[CoworkPlanner] ${item.id}: drafted ${steps.length} step(s) in ${loop.rounds} round(s) as automation ${automationId}`);
    return { automationId, summary: loop.summary, findings: await findingsOf(draft.def), rounds: loop.rounds };
}
