/**
 * Automation Builder — setting up a turn, before a model is chosen: what a
 * turn may send (TurnBody / TurnQuery), the Automations beta gate, the tiers
 * this person may use, the draft and its persisted builder session, the
 * work-mode state (the plan under review, the question round, a waiting
 * proposal, the checklist) and the catalogues the prompt and the tool gates
 * read. Moved verbatim from ./chatStream.js; the values land on the turn
 * object the route hands from phase to phase.
 */

const log = require('../../../telemetry/log');
const automationStore = require('../../../stores/automationStore');
const { getUserTierMap } = require('../../../core/llm/modelResolver');
const { tierAccessFor, tierRefusal } = require('../../../core/entitlements/tierAccess');
const { summariseDefinition, renderAgentDraftState } = require('../../../automation/summarise');
// Lives in automation/ rather than here because the MCP surface
// (automation/mcpBuilder.js) needs the same catalog, and automation/ may not
// require routes/ (server/layering.test.js).
const { buildCatalogForUser } = require('../../../automation/builderCatalog');
const { loadOrCreateDraft } = require('./builderDraft');
const { MODES, isBlankDraft, planMentionsRemoval, pendingProposal } = require('./workMode');
const { setupDatatableTurn, clientSnapshot } = require('./datatableTurn');
const { z, worded, bodyOf, queryOf, closedObject, choice, flag, typeError } = require('../../../core/http/schemaParts');

// ── What a turn may send ─────────────────────────────────────────────
// The keys the stream reads (see the header) and nothing else. The values
// stay as loose as the handler reads them — history and attachments are
// windowed and summarised downstream — but a misspelled key used to be a
// silent default under a 200 and a paid turn: `modelTeir` built on `auto`,
// `automationID` started a NEW draft beside the one on screen, and
// `webSearchEnabled: "false"` switched web search ON (`!!"false"`).
const text = (message) => worded(message).max(200, message);
const TurnBody = bodyOf({
    message: worded('message is the text of your turn.').nullish(),
    builderSessionId: text('builderSessionId is the id the previous turn handed back.').nullish(),
    automationId: text('automationId is the id of the automation being built.').nullish(),
    modelTier: text('modelTier is the name of a model tier.').nullish(),
    alwaysPlanLarge: flag('alwaysPlanLarge is true or false.').optional(),
    pauseAfterStep: flag('pauseAfterStep is true or false.').optional(),
    workMode: choice(MODES, 'workMode is discuss, approve, plan or build.').optional(),
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
 */
async function setupTurn(turn) {
    const {
        req, res, send, userId,
        message, clientSession, automationId, modelTier, workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId,
        history, seedMetadata, wantsResume,
    } = turn;
    // Feature gate: 'automations' is a per-org beta feature.
    // Admins toggle it from the admin dashboard → Security → Beta.
    // Super admins always have access.
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
    if (!hasFeature) {
        send('error', { error: 'The Automations beta is not enabled for your organisation. Ask an administrator to enable it under Security → Beta Features.' });
        res.end(); return false;
    }
    // Code steps are offered wherever they can run: there is no switch,
    // only the sandbox being installed.
    const codeStepEnabled = require('../../../automation/codeSandbox').isAvailable();

    // The tiers this turn may run on, read before a draft is loaded so a
    // refused turn leaves nothing behind. The map is EU-aware base tiers
    // plus custom tiers, the same source direct chat resolves against;
    // WHICH of them this person may use is core/entitlements/tierAccess,
    // for automation: the list the builder's own dropdown offers. It used
    // to be the map alone, so an explicit tier outside the person's groups
    // ran, and `auto` and the floor could land on any configured tier.
    const userOrgForTiers = req.session?.user?.organizationId || null;
    const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
    const tierAccess = await tierAccessFor({ userId, session: req.session, taskType: 'automation' });
    const requestedTier = modelTier || 'fast';
    const permittedTiers = tierAccess.narrow(tiers);
    // What `auto`, and the floor after it, may choose from.
    const { candidates: autoTiers, refused: autoRefused } = tierAccess.autoChoice(tiers);
    if (!tierAccess.allows(requestedTier) || (requestedTier === 'auto' && autoRefused)) {
        const refusal = tierRefusal(requestedTier);
        log.info(`[AutomationBuilder] Tier "${requestedTier}" is not available to this user — refused`);
        send('error', { error: refusal.error, code: refusal.code });
        res.end(); return false;
    }

    // Resolve / load the draft.
    let draftWrap = await loadOrCreateDraft({ userId, builderSessionId: clientSession, automationId, seedMetadata });
    send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });

    // The persisted builder session is read on EVERY turn of an existing
    // draft, not only on ?resume=1: it carries session state the prompt
    // must replay verbatim — the catalogue order chosen on the first turn
    // (see rankApps.applyCatalogOrder) and the to-do list. Before this the
    // to-do list was only seeded on a resume, so a normal second turn
    // started from an empty plan while the comment further down claimed
    // it "survives across turns".
    let snapshot = null;
    if (draftWrap.automationId) {
        try { snapshot = await automationStore.getBuilderSession(draftWrap.automationId, userId); }
        catch (_) { snapshot = null; /* non-fatal */ }
    }
    let reviewPlan = snapshot?.reviewPlan || null;
    let reviewQuestions = null;
    const planCurrent = !reviewPlan?.baseDefinition || JSON.stringify(reviewPlan.baseDefinition) === JSON.stringify(draftWrap.def);
    // A plan under review is built only against the draft it was written for.
    // A plan already being built (`building`: the build is not finished;
    // `paused`: it stopped for a question or a step) is the user's own work
    // going on: they may have touched the canvas in between, and refusing
    // every follow-up for that would leave the composer on "Building plan"
    // with no way to continue. Any work mode may carry the id (the composer
    // sends the mode the user chose and the id of the plan being built).
    const approvedPlan = !!req.body.workMode && approvedPlanId && reviewPlan?.id === approvedPlanId
        && (reviewPlan.status === 'review' ? planCurrent : ['paused', 'building'].includes(reviewPlan.status)) ? reviewPlan : null;
    if (approvedPlanId && !approvedPlan) {
        send('error', { error: 'This plan revision is no longer available. Review and approve the latest plan.' });
        res.end(); return false;
    }
    const turnMode = approvedPlan ? 'build' : workMode;
    // A new or empty draft is built directly: the size check is for
    // changes to a flow that already exists (BFSF-486).
    const bufferedBuild = turnMode === 'build' && alwaysPlanLarge && !approvedPlan && !isBlankDraft(draftWrap.def);
    const permissionMode = bufferedBuild ? 'approve' : turnMode;
    const isolated = turnMode !== 'build' || bufferedBuild;
    // An approved plan that names a step to remove lets this build turn call
    // builder_remove_step — for exactly the steps that plan names (checked per
    // call at the dispatch below). Never in a buffered build, which stages.
    const planAllowsRemoval = !!approvedPlan && !bufferedBuild && planMentionsRemoval(approvedPlan);
    let pausedAfterStep = false;
    let baseDraft = structuredClone(draftWrap.def);
    let baseTitle = draftWrap.title;
    let baseDescription = draftWrap.description;
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
    // from the live draft (BFSF-486). The live draft stays the base.
    const savedProposal = pendingProposal(snapshot?.proposal, baseDraft);
    const reviewOutcome = snapshot?.reviewOutcome || null;
    // ── The question round of a plan ──
    // One round per plan cycle, everything asked at once. The cycle starts
    // with the first plan turn after a built, rejected or missing plan and
    // ends when builder_write_plan succeeds. The server remembers that it
    // asked (`questionsMeta` in the snapshot): the model alone did not, and
    // asked again after every answer.
    const priorQuestions = Array.isArray(snapshot?.reviewQuestions) && snapshot.reviewQuestions.length ? snapshot.reviewQuestions : null;
    const cycleOver = (reviewOutcome?.kind === 'plan' && reviewOutcome.status === 'rejected') || snapshot?.reviewPlan?.status === 'built';
    const priorMeta = cycleOver ? null : (snapshot?.questionsMeta || null);
    let planCycleRound = (turnMode === 'plan' && priorMeta?.mode === 'plan') ? (priorMeta.round || 0) : 0;
    // The previous turn showed the card and this turn is the user's reply
    // (the card's answers or a typed message): the plan follows now.
    const answerTurn = turnMode === 'plan' && !!priorQuestions;
    const questionsClosed = turnMode === 'plan' && (planCycleRound >= 1 || answerTurn);
    let planWritten = false;
    if (isolated && savedProposal) {
        draftWrap.def = structuredClone(savedProposal.definition);
        if (typeof savedProposal.title === 'string') draftWrap.title = savedProposal.title;
        if (savedProposal.description != null) draftWrap.description = savedProposal.description;
    }
    if (approvedPlan) reviewPlan = { ...reviewPlan, status: 'building', pauseAfterStep };
    if (reviewPlan) send('review_plan', { plan: reviewPlan });
    // Resume support — when the client asks (?resume=1), re-emit the
    // last persisted snapshot before processing the new turn. The
    // client uses this to rehydrate any chat history + draft +
    // validation state that was lost on a dropped SSE.
    if (wantsResume && snapshot) {
        send('resume', { snapshot: clientSnapshot(snapshot) });
        if (Array.isArray(snapshot.todos) && snapshot.todos.length) send('plan', { todos: snapshot.todos });
    }
    // Per-turn to-do list (builder_set_plan), carried across turns.
    draftWrap._todos = Array.isArray(snapshot?.todos) ? snapshot.todos : [];
    // The checklist belongs to a build. A list from an earlier turn would
    // tick and spin in Plan first (the owner saw "Plan 3/4" with no Build
    // button) and its items ("wait for approval") tell an approved build to
    // wait. So: nothing in a planning or discussing turn, and the approved
    // plan's own steps in a build. A paused or continuing build keeps the
    // list it has when it is already that plan's, so its progress survives.
    if (approvedPlan) {
        const steps = Array.isArray(approvedPlan.steps) ? approvedPlan.steps.filter(t => typeof t === 'string') : [];
        const sameList = draftWrap._todos.length === steps.length && steps.every((t, i) => draftWrap._todos[i]?.text === t);
        if (!sameList) draftWrap._todos = steps.map(text => ({ text, done: false }));
        send('plan', { todos: draftWrap._todos });
    } else if (req.body.workMode && (turnMode === 'plan' || turnMode === 'discuss')) {
        draftWrap._todos = [];
        send('plan', { todos: [] });
    }
    // Catalogue order fixed on this session's first turn; null until then.
    const storedCatalogOrder = Array.isArray(snapshot?.catalogOrder) ? snapshot.catalogOrder : null;

    // Build catalog for the prompt. (Prompt construction is deferred
    // until after the model is resolved, so we can pick full vs. lean
    // prompt + apply per-model catalog filtering — see Step 5 of the
    // multi-model optimization in the plan file.)
    const catalog = await buildCatalogForUser(userId, req.session);

    // §B progressive context: index every catalog action's input schema by
    // tool name so builder_inspect_tool can return exact params on demand
    // (the slim prompt catalog only advertises an input count), and the
    // add-action gate can require an inspect before binding non-trivial
    // params. `_inspectedTools` tracks what the agent inspected this turn.
    //
    // Built from the catalog's `actions`, which buildCatalogForUser has
    // already narrowed to what this user can RUN. It used to be built from
    // the full TOOL_REGISTRY, and that is what let `unknownToolError` read
    // "the catalog knows this tool's schema" as "the user has this tool".
    // The two lists must come from one source or they drift back apart.
    draftWrap._inputSchemasByTool = {};
    for (const app of (catalog?.apps || [])) {
        for (const act of (app.actions || [])) {
            if (act && act.name && act.inputSchema) draftWrap._inputSchemasByTool[act.name] = act.inputSchema;
        }
    }
    // The authorisation set, and deliberately NOT derived from `apps`: the
    // resolved set also carries MCP, org-custom, agent-callable-automation and
    // Step tools, which own no TOOL_REGISTRY entry and so never appear in
    // `apps`. Gating on `apps` would refuse tools the user really has.
    // Nor is `_inputSchemasByTool` the authority — it is keyed on tools
    // that HAVE an input schema, so a parameterless tool would vanish.
    draftWrap._availableToolNames = catalog?.toolNames instanceof Set ? catalog.toolNames : null;
    draftWrap._inspectedTools = new Set();
    // What the draft's tools really returned on this user's last live run
    // (shapeCache), read by the path checks (builderTools/refCheck.js,
    // outputFields.js) before the curated shapes. One cache read per tool,
    // under a deadline, never an error: the MCP surface does the same.
    draftWrap._runtimeShapes = await require('../../../automation/mcpBuilder').loadRuntimeShapes(draftWrap.def, userId);
    // The datatables THIS user may address — rendered into the prompt as
    // the "Datatables you may use" block and read by builder_add_datatable
    // for its id/key/column check. Two absent shapes, two meanings:
    // null = could not tell (store outage) → permissive, the same posture
    // as `_availableToolNames`; [] = the user has none → a datatable step
    // is refused. Before this the prompt pointed at "the catalog" for
    // table ids and the catalog carried apps only, so the model invented
    // `tbl_…` ids on every invoice brief.
    try {
        const { buildDatatableCatalogForUser } = require('../../../automation/builderDatatableCatalog');
        draftWrap._datatables = await buildDatatableCatalogForUser(userId);
    } catch (e) {
        log.warn('[AutomationBuilder] datatable catalog unavailable:', e.message);
        draftWrap._datatables = null;
    }
    catalog.datatables = draftWrap._datatables;
    // Tables and consent (builderTools/pendingDatatables, datatableApproval).
    // Set AFTER catalog.datatables above, which stays the plain list, so the
    // cached prompt block does not change when a proposal stages a table;
    // the model learns of staged tables from the review note instead.
    const tableChoice = await setupDatatableTurn({ draftWrap, catalog, req, userId, snapshot, savedProposal, baseDraft, approvedPlan, history, message, isolated, permissionMode });

    // The DESIGNED documents this user may fill — rendered as the
    // "Documents you may fill" block and read by builder_add_fill_document
    // for its id/placeholder check. Same two absent shapes, same meanings
    // as the datatable list above.
    draftWrap._documentDiscoveryRequired = true;
    try {
        const { buildDocumentCatalogForUser } = require('../../../automation/builderDocumentCatalog');
        draftWrap._documents = await buildDocumentCatalogForUser(userId);
    } catch (e) {
        log.warn('[AutomationBuilder] document catalog unavailable:', e.message);
        draftWrap._documents = null;
    }
    catalog.documents = draftWrap._documents;

    // The lists the model fills ids from — agents, knowledge bases, and the
    // app_event providers THIS user has — with the canvas pickers' own
    // permission filters. Each fails into its own "could not read" marker
    // (never into "none"), and none of them throws. They are rendered into
    // the late dynamic message, not the cached system prompt.
    Object.assign(catalog, await require('../../../automation/builderPickerCatalog')
        .buildPickerCatalogsForUser(userId, req.session, catalog));

    // Human-readable summary — seeds `lastSummary` (the "What this
    // automation does" panel + builder_session snapshot). User-facing, so
    // it stays prose without raw step IDs.
    const summary = summariseDefinition(baseDraft).summary;
    // Agent context: a structured, ID-bearing view of the WHOLE draft
    // (main flow + every flowlet) with each step's settings and input
    // bindings, so the model reads real step IDs + current wiring instead
    // of asking the user for them. Rebuilt each turn from the live draft.
    const agentDraftState = renderAgentDraftState(draftWrap.def);

    Object.assign(turn, {
        codeStepEnabled, userOrgForTiers, tiers, requestedTier, permittedTiers, autoTiers,
        draftWrap, snapshot, reviewPlan, reviewQuestions, planCurrent, approvedPlan, turnMode,
        bufferedBuild, permissionMode, isolated, planAllowsRemoval, pausedAfterStep,
        baseDraft, baseTitle, baseDescription, savedProposal, reviewOutcome,
        priorQuestions, priorMeta, planCycleRound, answerTurn, questionsClosed, planWritten,
        storedCatalogOrder, catalog, tableChoice, summary, agentDraftState,
    });
    return true;
}

module.exports = { TurnBody, TurnQuery, setupTurn };
