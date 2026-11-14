// @typecheck
/**
 * Automation Builder — setting up a turn, before a model is chosen: what a
 * turn may send (TurnBody / TurnQuery), the Automations beta gate, the tiers
 * this person may use, the draft and its persisted builder session, the
 * work-mode state (the plan under review, the question round, a waiting
 * proposal, the checklist) and the catalogues the prompt and the tool gates
 * read. Moved verbatim from ./chatStream.js; the values land on the turn
 * object the route hands from phase to phase.
 */

const { summariseDefinition, renderAgentDraftState } = require('../../../automation/summarise');
const { MODES, isBlankDraft, planMentionsRemoval, pendingProposal } = require('../../../usecases/ai/automationBuilder/workMode');
const { clientSnapshot } = require('../../../usecases/ai/automationBuilder/proposalPayload');
const { passesFeatureGate, tiersOfTurn, loadDraftAndSession, approvedPlanOf, questionRound, seedTodos, loadCatalogs } = require('./turnSetupSteps');
const { turnModeOf } = require('../../../usecases/ai/automationBuilder/modeRules.mts');
const { z, worded, bodyOf, queryOf, closedObject, choice, flag, typeError } = require('../../../core/http/schemaParts');

/**
 * The draft wrapper of a builder turn: the loaded draft plus the turn state
 * the phases set on it (underscore members).
 * @typedef {import('../../../automation/mcpBuilder').McpDraftWrap & import('../../../automation/builderTools/refCheck').BuilderWrap & {
 *   def: import('../../../automation/builderTools/draftGraph').DraftGraph,
 *   _resultDetail?: 'full' | 'compact',
 *   _todos?: Array<{ text: string, done: boolean }>,
 *   _inspectedTools?: Set<string>,
 *   _offeredTools?: Set<string>,
 *   _stagedDryRun?: boolean,
 *   _documentDiscoveryRequired?: boolean,
 *   _onDryRunStarted?: ((created: { id: string, status?: string, startedAt?: string }) => void) | null,
 * }} BuilderDraftWrap
 */
/**
 * The turn object ./chatStream.js builds from the request; each phase
 * (setupTurn, resolveTurnModel, assembleTurnPrompt, buildToolMenu, the build
 * loop) adds its part.
 * @typedef {Awaited<ReturnType<typeof import('../../../core/entitlements/tierAccess').tierAccessFor>>} TurnTierAccess
 * @typedef {{
 *   req: import('express').Request, res: import('express').Response, userId: string,
 *   message: string | null, clientSession: string | null, automationId: string | null, modelTier: string,
 *   workMode: string, alwaysPlanLarge: boolean, pauseAfterStep: boolean, approvedPlanId: string | null,
 *   selectedStepId: string | null, history: unknown[], attachments: unknown[], webSearchEnabled: boolean,
 *   disabledMedia: Record<string, unknown>, timezone: string | null, canvasScope: string | null,
 *   seedMetadata: { title?: string, description?: string } | null, wantsResume: boolean,
 *   send: (event: string, data: unknown) => void,
 *   narrator: ReturnType<typeof import('../../../usecases/ai/automationBuilder/thoughtNarrator').createThoughtNarrator> | null,
 *   codeStepEnabled: boolean, userOrgForTiers: string | null,
 *   tiers: Awaited<ReturnType<typeof import('../../../core/llm/modelResolver').getUserTierMap>>, requestedTier: string,
 *   permittedTiers: Awaited<ReturnType<typeof import('../../../core/llm/modelResolver').getUserTierMap>>,
 *   autoTiers: Awaited<ReturnType<typeof import('../../../core/llm/modelResolver').getUserTierMap>>,
 *   draftWrap: BuilderDraftWrap,
 *   snapshot: Awaited<ReturnType<typeof import('../../../stores/automationStore').getBuilderSession>> | null,
 *   reviewPlan: Awaited<ReturnType<typeof import('../../../stores/automationStore').getBuilderSession>>['reviewPlan'] | null,
 *   reviewQuestions: Array<{ choice?: unknown, [k: string]: unknown }> | null,
 *   planCurrent: boolean,
 *   approvedPlan: Awaited<ReturnType<typeof import('../../../stores/automationStore').getBuilderSession>>['reviewPlan'] | null,
 *   turnMode: string, bufferedBuild: boolean, permissionMode: string, isolated: boolean,
 *   planAllowsRemoval: boolean, pausedAfterStep: boolean,
 *   baseDraft: import('../../../automation/builderTools/draftGraph').DraftGraph,
 *   baseTitle: string | undefined, baseDescription: string | undefined,
 *   savedProposal: ReturnType<typeof pendingProposal>,
 *   reviewOutcome: Awaited<ReturnType<typeof import('../../../stores/automationStore').getBuilderSession>>['reviewOutcome'] | null,
 *   priorQuestions: unknown[] | null,
 *   priorMeta: Awaited<ReturnType<typeof import('../../../stores/automationStore').getBuilderSession>>['questionsMeta'] | null,
 *   planCycleRound: number, answerTurn: boolean, questionsClosed: boolean, planWritten: boolean,
 *   storedCatalogOrder: string[] | null,
 *   catalog: Awaited<ReturnType<typeof import('../../../automation/builderCatalog').buildCatalogForUser>> & { toolNames?: Set<string>, datatables?: BuilderDraftWrap['_datatables'], documents?: BuilderDraftWrap['_documents'], datatableRequireChoice?: boolean },
 *   tableChoice: Awaited<ReturnType<typeof import('./datatableTurn').setupDatatableTurn>>,
 *   summary: string, agentDraftState: string,
 *   modelId: string, cfg: Awaited<ReturnType<typeof import('../../../core/aiAgent').getProviderForModel>>,
 *   tier: Awaited<ReturnType<typeof import('../../../core/llm/modelResolver').getUserTierMap>>[string],
 *   adapter: ReturnType<typeof import('../../../core/providers').getAdapter>,
 *   narrationModelId: string, thinkingModelId: string,
 *   profile: ReturnType<typeof import('../../../core/automationModel/builderModelProfiles').getProfileForModel>,
 *   catalogOrder: ReturnType<typeof import('../../../automation/builderPrompt/rankApps').catalogOrderOf> | null,
 *   webResearch: Awaited<ReturnType<typeof import('../../../usecases/ai/automationBuilder/webResearch').resolveWebResearch>>,
 *   sys: ReturnType<typeof import('../../../usecases/ai/automationBuilder/turnMessages').composeTurnMessages>['sys'],
 *   fewShotMessages: ReturnType<typeof import('../../../usecases/ai/automationBuilder/turnMessages').composeTurnMessages>['fewShotMessages'],
 *   windowedHistory: ReturnType<typeof import('../../../usecases/ai/automationBuilder/turnMessages').composeTurnMessages>['windowedHistory'],
 *   messages: ReturnType<typeof import('../../../usecases/ai/automationBuilder/turnMessages').composeTurnMessages>['messages'],
 *   tools: ReturnType<typeof import('../../../automation/builderTools/schemaProjection').projectToolSchemas>,
 *   webpageInspectorEnabled: boolean,
 *   webpageInspectorCtx: { userId: string, organizationId: string | null, userGroupIds: string[], userOrgIds: string[] } | null,
 *   isWebpageAutomationTool: typeof import('../../../integrations/webpageAutomationTools').isWebpageAutomationTool,
 *   executeWebpageAutomationTool: typeof import('../../../integrations/webpageAutomationTools').executeWebpageAutomationTool,
 *   webpageToolGate: ReturnType<typeof import('../../../core/privacy/toolPiiGate').toolLoopGate>,
 *   brief: string, sendMetadata: () => void, iterationBudget: number, clientGone: boolean,
 *   clientAbort: AbortController, lastFinalized: boolean,
 *   lastValidation: ReturnType<typeof import('../../../automation/validate').validateDefinition> | null,
 *   lastSummary: string | null,
 *   stopReason: { reason: string, tool?: string | null, error?: string, label?: string | null, position?: unknown } | null,
 *   usageTotals: { prompt: number, completion: number, cached: number, cacheCreation: number, rounds: number },
 *   turnEffort: ReturnType<typeof import('../../../core/automationModel/builderModelProfiles').effortForIteration>,
 *   iter: number,
 * }} BuilderTurn
 */
/**
 * One round of the build loop (./buildLoop.js): what its tool calls did.
 * @typedef {{
 *   mutatedThisIter: boolean, testedThisIter: boolean, acceptedThisIter: boolean, refusedThisIter: boolean,
 *   stopHit: { reason: string, tool?: string | null, error?: string, label?: string | null, position?: unknown } | null,
 *   lastRefusal: { tool: string | null, error: string, label: string | null } | null,
 * }} BuilderRound
 * One tool call of a round, as the adapter hands it over.
 * @typedef {{ id: string, function: { name: string, arguments: string }, _recovered?: boolean, _repaired?: boolean }} BuilderToolCall
 */

// ── What a turn may send ─────────────────────────────────────────────
// The keys the stream reads (see the header) and nothing else. The values
// stay as loose as the handler reads them — history and attachments are
// windowed and summarised downstream — but a misspelled key would be a
// silent default under a 200 and a paid turn: `modelTeir` built on `auto`,
// `automationID` started a NEW draft beside the one on screen, and
// `webSearchEnabled: "false"` switched web search ON (`!!"false"`).
const text = (/** @type {string} */ message) => worded(message).max(200, message);
const TurnBody = bodyOf({
    message: worded('message is the text of your turn.').nullish(),
    builderSessionId: text('builderSessionId is the id the previous turn handed back.').nullish(),
    automationId: text('automationId is the id of the automation being built.').nullish(),
    modelTier: text('modelTier is the name of a model tier.').nullish(),
    alwaysPlanLarge: flag('alwaysPlanLarge is true or false.').optional(),
    pauseAfterStep: flag('pauseAfterStep is true or false.').optional(),
    workMode: choice(MODES, 'workMode is describe, discuss, approve, plan or build.').optional(),
    approvedPlanId: text('approvedPlanId is the exact plan revision approved by the user.').nullish(),
    selectedStepId: text('selectedStepId is the step the user is asking about.').nullish(),
    history: z.array(z.unknown(), { error: typeError({ invalid: 'history is the list of earlier turns.' }) }).nullish(),
    attachments: z.array(z.unknown(), { error: typeError({ invalid: 'attachments is a list of files.' }) }).nullish(),
    webSearchEnabled: flag('webSearchEnabled is true or false.').nullish(),
    disabledMedia: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'disabledMedia is an object of media kinds.' }) }).nullish(),
    timezone: text('timezone is a zone name, like Europe/Amsterdam.').nullish(),
    canvasScope: text('canvasScope is the key of the layer on screen.').nullish(),
    seedMetadata: closedObject({
        title: worded('seedMetadata.title is text.').optional(),
        description: worded('seedMetadata.description is text.').optional(),
    }, 'seedMetadata').nullish(),
}, 'A builder turn');
const TurnQuery = queryOf({
    resume: choice(['1', 'true'], 'resume is 1 when reconnecting; leave it out otherwise.').optional(),
}, 'The builder stream');

/**
 * Everything before the model: gate, tiers, draft, session, work mode,
 * catalogues. Answers false when the turn already ended with an `error`
 * event (the gate, a refused tier, a stale plan revision).
 * @param {BuilderTurn} turn
 */
async function setupTurn(turn) {
    const { res, send, workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId, wantsResume } = turn;
    if (!await passesFeatureGate(turn)) return false;
    // Code steps are offered wherever they can run: there is no switch,
    // only the sandbox being installed.
    const codeStepEnabled = require('../../../automation/codeSandbox').isAvailable();
    const tierChoice = await tiersOfTurn(turn);
    if (!tierChoice) return false;

    const { draftWrap, snapshot } = await loadDraftAndSession(turn);
    let reviewPlan = snapshot?.reviewPlan || null;
    const reviewQuestions = null;
    const planCurrent = !reviewPlan?.baseDefinition || JSON.stringify(reviewPlan.baseDefinition) === JSON.stringify(draftWrap.def);
    const approvedPlan = approvedPlanOf(turn, reviewPlan, planCurrent);
    if (approvedPlanId && !approvedPlan) {
        send('error', { error: 'This plan revision is no longer available. Review and approve the latest plan.' });
        res.end(); return false;
    }
    const turnMode = turnModeOf(workMode, approvedPlan);
    // A new or empty draft is built directly: the size check is for
    // changes to a flow that already exists.
    const bufferedBuild = turnMode === 'build' && alwaysPlanLarge && !approvedPlan && !isBlankDraft(draftWrap.def);
    const permissionMode = bufferedBuild ? 'approve' : turnMode;
    const isolated = turnMode !== 'build' || bufferedBuild;
    // An approved plan that names a step to remove lets this build turn call
    // builder_remove_step, for exactly the steps that plan names (checked per
    // call at the dispatch). Never in a buffered build, which stages.
    const planAllowsRemoval = !!approvedPlan && !bufferedBuild && planMentionsRemoval(approvedPlan);
    const pausedAfterStep = false;
    const baseDraft = structuredClone(draftWrap.def);
    const baseTitle = draftWrap.title;
    const baseDescription = draftWrap.description;
    // Preview mutations operate on their own copy; the persisted definition
    // and all runtime actions remain untouched until a human applies it.
    if (isolated) draftWrap.def = structuredClone(baseDraft);
    // A dry run in an isolated turn runs the STAGED definition in memory and
    // saves nothing (builderTools: builder_request_dry_run). The proposal is
    // the user's to apply; the saved draft stays as it was.
    draftWrap._stagedDryRun = isolated;
    // A proposal from an earlier turn that still waits for Apply. An
    // isolated turn works ON it, so the agent's draft view shows what it
    // staged and a follow-up adds to the proposal instead of starting over
    // from the live draft. The live draft stays the base.
    const savedProposal = pendingProposal(snapshot?.proposal, baseDraft);
    const questions = questionRound(snapshot, turnMode);
    const planWritten = false;
    if (isolated && savedProposal) {
        draftWrap.def = structuredClone(savedProposal.definition);
        if (typeof savedProposal.title === 'string') draftWrap.title = savedProposal.title;
        if (savedProposal.description != null) draftWrap.description = savedProposal.description;
    }
    if (approvedPlan) reviewPlan = { ...reviewPlan, status: 'building', pauseAfterStep };
    if (reviewPlan) send('review_plan', { plan: reviewPlan });
    // Resume support: when the client asks (?resume=1), re-emit the last
    // persisted snapshot before processing the new turn. The client uses
    // this to rehydrate the chat history, draft and validation state that
    // was lost on a dropped SSE.
    if (wantsResume && snapshot) {
        send('resume', { snapshot: clientSnapshot(snapshot) });
        if (Array.isArray(snapshot.todos) && snapshot.todos.length) send('plan', { todos: snapshot.todos });
    }
    seedTodos(turn, draftWrap, snapshot, approvedPlan, turnMode);
    // Catalogue order fixed on this session's first turn; null until then.
    const storedCatalogOrder = Array.isArray(snapshot?.catalogOrder) ? snapshot.catalogOrder : null;

    const { catalog, tableChoice } = await loadCatalogs(turn, draftWrap, { snapshot, savedProposal, baseDraft, approvedPlan, isolated, permissionMode });

    // Human-readable summary: seeds `lastSummary` (the "What this
    // automation does" panel and the builder_session snapshot). User-facing,
    // so it stays prose without raw step IDs.
    const summary = summariseDefinition(baseDraft).summary;
    // Agent context: a structured, ID-bearing view of the WHOLE draft (main
    // flow and every flowlet) with each step's settings and input bindings,
    // so the model reads real step IDs and current wiring instead of asking
    // the user for them. Rebuilt each turn from the live draft.
    const agentDraftState = renderAgentDraftState(draftWrap.def);

    Object.assign(turn, {
        codeStepEnabled, ...tierChoice,
        draftWrap, snapshot, reviewPlan, reviewQuestions, planCurrent, approvedPlan, turnMode,
        bufferedBuild, permissionMode, isolated, planAllowsRemoval, pausedAfterStep,
        baseDraft, baseTitle, baseDescription, savedProposal, ...questions, planWritten,
        storedCatalogOrder, catalog, tableChoice, summary, agentDraftState,
    });
    return true;
}

module.exports = { TurnBody, TurnQuery, setupTurn };
