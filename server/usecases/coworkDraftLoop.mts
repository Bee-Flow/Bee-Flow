/**
 * The draft loop of Cowork: a model drafts a definition with the automation builder's own tools, on a narrow menu,
 * and hears after every change why the draft may not be what it should be. Two callers:
 *
 *   - the planner (./coworkPlanner.mts): a PLAN from an item's brief;
 *   - the goal planner (./coworkGoalPlanner.mts): the CHECK of a goal, from its sentence, on a read-only menu.
 *
 * The loop is the flowlet agent's (automation/flowletAgent.js) on the root graph: the model's tool calls are carried
 * out on the draft by the builder, a call outside the caller's menu is refused before it is carried out, and after a
 * change the builder's validation and the caller's own rules (`findingsOf`) go back to the model as one report. The
 * draft is not stored here: the caller decides what becomes of it.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, PlanStep, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { stepsOf } from '../core/cowork/plan/planWalk.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { planReport, type ValidationRecord } from './coworkPlannerPrompt.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { warn: (msg: string) => void };

export type Schema = { type?: string; function?: { name?: string; [key: string]: unknown }; [key: string]: unknown };
interface ToolCall { id: string; function: { name: string; arguments?: unknown }; [key: string]: unknown }
export interface ChatResponse { content?: string | null; toolCalls?: ToolCall[] | null; usage?: unknown }
export type Message = Record<string, unknown>;

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

export interface Catalog { toolNames?: unknown; datatables?: unknown; [key: string]: unknown }

/** The automation builder, as far as a draft loop uses it. */
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

/** What a draft loop needs from the world. */
export interface LoopDeps {
    /** The model tiers this person may name in an AI step. */
    tiersFor: (who: { userOrgId: string | null; userId: string }) => Promise<Record<string, unknown>>;
    chat: (modelId: string, messages: Message[], options: Record<string, unknown>) => Promise<ChatResponse>;
    logUsage: (call: Record<string, unknown>) => void;
    builder: BuilderPort;
    lookups: ToolLookups;
    now: () => number;
    /** The whole making of a draft may take this long. */
    maxMs: number;
}

/** What the page is told while a draft is being made. */
export type DraftProgress =
    | { phase: 'thinking'; round: number }
    | { phase: 'drafted'; round: number; steps: Array<Pick<PlanStep, 'id' | 'title' | 'kind'>> }
    | { phase: 'saving' };

const TITLE_MAX = 120;

export interface DraftSpec { userId: string; userOrgId: string | null; catalog: Catalog; sessionId: string; title: string; description: string }

/** An empty draft of the owner's, with their tables, tools and model tiers. */
export async function newDraft(spec: DraftSpec, deps: Pick<LoopDeps, 'tiersFor' | 'builder'>): Promise<DraftWrap> {
    const { userId, userOrgId, catalog } = spec;
    const [tiers, datatables] = await Promise.all([
        deps.tiersFor({ userOrgId, userId }),
        deps.builder.datatablesFor(userId).catch((err: Error) => {
            log.warn(`[CoworkPlanner] datatable catalog unavailable: ${err.message}`);
            return null;
        }),
    ]);
    catalog.datatables = datatables;
    return {
        userId,
        orgId: userOrgId,
        automationId: null,
        builderSessionId: spec.sessionId,
        title: spec.title.slice(0, TITLE_MAX),
        description: spec.description,
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

/** The tools a loop offers, and why a call is not carried out (null: it may go ahead). */
export interface Menu { tools: Schema[]; refusal: (name: string, args: unknown) => string | null }

/** Carry out one tool call of the model on the draft, or refuse it; answers what the model is told. */
async function runTool(call: ToolCall, draft: DraftWrap, builder: BuilderPort, menu: Menu): Promise<{ result: unknown; mutated: boolean }> {
    const name = call.function.name;
    const args = argsOf(call);
    const refusal = menu.refusal(name, args);
    if (refusal) return { result: { error: refusal }, mutated: false };
    // One list of steps: every call works on the root graph.
    delete args.scope;
    let result: unknown;
    try { result = await builder.applyToolCall(name, args, draft); } catch (e) { result = { error: (e as Error).message }; }
    const failed = !!result && typeof result === 'object' && 'error' in result && !!(result as { error?: unknown }).error;
    return { result, mutated: builder.mutatingTools.has(name) && !failed };
}

export interface LoopResult { summary: string; rounds: number }

export interface LoopInput {
    preferredTier?: string | null;
    draft: DraftWrap;
    modelId: string;
    system: string;
    /** The first user turn ("Make the plan for this work."). */
    ask: string;
    menu: Menu;
    maxRounds: number;
    findingsOf: (def: Definition) => Promise<PlanFinding[]>;
    onProgress?: (progress: DraftProgress) => void;
    /** The Cowork run whose cost this drafting is booked on (a repair: the run that set it off), so it counts on the item's budget. */
    bookOn?: string | null;
    /** A conversation to go on with (the planner after a try-out): the loop adds to it, and `system` and `ask` are not sent again. */
    messages?: Message[];
}

function applyPreferredTier(definition: Definition, tier?: string | null) {
    if (!tier || tier === 'auto') return;
    for (const { type, step } of stepsOf(definition)) {
        if (type === 'ai_step') step.modelTier = tier;
    }
}

/** The model and its tools, until the model stops, the rounds are used up or the caller gave up. */
async function draftLoop(input: LoopInput & { signal: AbortSignal }, deps: LoopDeps): Promise<LoopResult> {
    const { draft, modelId, signal, findingsOf, onProgress, menu } = input;
    const { builder } = deps;
    const messages: Message[] = input.messages ?? [{ role: 'system', content: input.system }, { role: 'user', content: input.ask }];
    let summary = '';
    let rounds = 0;
    for (let round = 0; round < input.maxRounds; round++) {
        signal.throwIfAborted();
        rounds = round + 1;
        onProgress?.({ phase: 'thinking', round });
        const startedAt = deps.now();
        const response = await deps.chat(modelId, messages, { signal, maxTokens: 8192, temperature: 0.2, tools: menu.tools, toolChoice: 'auto', reasoningEffort: 'medium' });
        deps.logUsage({ source: 'cowork_planner', userId: draft.userId, orgId: draft.orgId, model: modelId, usage: response.usage, startedAt, conversationId: draft.builderSessionId, ...(input.bookOn ? { runId: input.bookOn } : {}) });
        if (response.content) summary = response.content;
        if (!response.toolCalls || response.toolCalls.length === 0) break;

        messages.push(assistantMessage(response));
        let mutated = false;
        for (const call of response.toolCalls) {
            const done = await runTool(call, draft, builder, menu);
            mutated = mutated || done.mutated;
            messages.push({ role: 'tool', tool_call_id: call.id, content: builder.resultText(done.result) });
        }
        if (!mutated) continue;
        applyPreferredTier(draft.def, input.preferredTier);
        onProgress?.({ phase: 'drafted', round, steps: planViewOf(draft.def, deps.lookups).steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind })) });
        const report = planReport(builder.errorsOf(draft.def), await findingsOf(draft.def));
        if (report) messages.push({ role: 'user', content: report });
    }
    return { summary: summary.trim(), rounds };
}

/** The caller's signal and the loop's own time limit, as one. */
function limited(signal: AbortSignal | null | undefined, maxMs: number): AbortSignal {
    const limit = AbortSignal.timeout(maxMs);
    return signal ? AbortSignal.any([signal, limit]) : limit;
}

/** The draft loop under its time limit: past it the caller hears `tooLong` (a 504 with code `timeoutCode`). */
export async function draftWithin(loop: LoopInput, callerSignal: AbortSignal | null | undefined, tooLong: { code: string; message: string }, deps: LoopDeps): Promise<LoopResult> {
    const signal = limited(callerSignal, deps.maxMs);
    try {
        return await draftLoop({ ...loop, signal }, deps);
    } catch (e) {
        if (signal.aborted && !callerSignal?.aborted) throw new HttpError(504, tooLong.code, tooLong.message);
        throw e;
    }
}
