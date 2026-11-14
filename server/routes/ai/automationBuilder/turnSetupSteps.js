// @typecheck strict
/**
 * Automation Builder: the steps of setting a turn up (./turnSetup.js runs
 * them in order): the feature gate, the tiers the person may use, the draft
 * and its stored session, the approved plan, the question round, the
 * checklist and the catalogues.
 */

const log = require('../../../telemetry/log');
const automationStore = require('../../../stores/automationStore');
const { getUserTierMap } = require('../../../core/llm/modelResolver');
const { tierAccessFor, tierRefusal } = require('../../../core/entitlements/tierAccess');
// The catalogue lives in automation/ rather than here because the MCP surface
// (automation/mcpBuilder.js) needs the same one, and automation/ may not
// require routes/ (server/layering.test.js).
const { buildCatalogForUser, inputSchemasByTool, inspectedToolsFrom } = require('../../../automation/builderCatalog');
const { loadOrCreateDraft } = require('../../../usecases/ai/automationBuilder/builderDraft');
const { setupDatatableTurn } = require('./datatableTurn');

/**
 * @typedef {import('./turnSetup').BuilderTurn} BuilderTurn
 * @typedef {import('./turnSetup').BuilderDraftWrap} BuilderDraftWrap
 */

/**
 * The feature gate: 'automations' is a per-org beta feature (admin
 * dashboard → Security → Beta); super admins always have access. False when
 * the turn ended with the gate's `error` event.
 * @param {BuilderTurn} turn
 */
async function passesFeatureGate(turn) {
    const { req, res, send, userId } = turn;
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
    if (hasFeature) return true;
    send('error', { error: 'The Automations beta is not enabled for your organisation. Ask an administrator to enable it under Security → Beta Features.' });
    res.end();
    return false;
}

/**
 * The tiers this turn may run on, read before a draft is loaded so a refused
 * turn leaves nothing behind. The map is EU-aware base tiers plus custom
 * tiers, the same source direct chat resolves against; WHICH of them this
 * person may use is core/entitlements/tierAccess for automation: the list
 * the builder's own dropdown offers. Null when the requested tier was
 * refused (the turn ended with an `error` event).
 * @param {BuilderTurn} turn
 */
async function tiersOfTurn(turn) {
    const { req, res, send, userId, modelTier } = turn;
    const userOrgForTiers = req.session?.user?.organizationId || null;
    const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
    const tierAccess = await tierAccessFor({ userId, session: req.session, taskType: 'automation' });
    const requestedTier = modelTier || 'fast';
    const permittedTiers = tierAccess.narrow(tiers);
    // What `auto`, and the floor after it, may choose from.
    const { candidates: autoTiers, refused: autoRefused } = tierAccess.autoChoice(/** @type {Record<string, { modelId?: unknown }>} */ (tiers));
    if (!tierAccess.allows(requestedTier) || (requestedTier === 'auto' && autoRefused)) {
        const refusal = tierRefusal(requestedTier);
        log.info(`[AutomationBuilder] Tier "${requestedTier}" is not available to this user — refused`);
        send('error', { error: refusal.error, code: refusal.code });
        res.end();
        return null;
    }
    return { userOrgForTiers, tiers, requestedTier, permittedTiers, autoTiers };
}

/**
 * The draft and its stored builder session. The session is read on EVERY
 * turn of an existing draft, not only on ?resume=1: it carries state the
 * prompt must replay verbatim (the catalogue order chosen on the first turn,
 * see rankApps.applyCatalogOrder, and the to-do list).
 * @param {BuilderTurn} turn
 */
async function loadDraftAndSession(turn) {
    const { send, userId, clientSession, automationId, seedMetadata } = turn;
    /** @type {BuilderDraftWrap} */
    const draftWrap = await loadOrCreateDraft({ userId, builderSessionId: clientSession, automationId, seedMetadata });
    send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });
    let snapshot = null;
    if (draftWrap.automationId) {
        try { snapshot = await automationStore.getBuilderSession(draftWrap.automationId, userId); }
        catch (_) { snapshot = null; /* non-fatal */ }
    }
    return { draftWrap, snapshot };
}

/**
 * The plan this turn builds, when the request names one. A plan under review
 * is built only against the draft it was written for. A plan already being
 * built (`building`: the build is not finished; `paused`: it stopped for a
 * question or a step) is the user's own work going on: they may have touched
 * the canvas in between, and refusing every follow-up for that would leave
 * the composer on "Building plan" with no way to continue. Any work mode may
 * carry the id (the composer sends the mode the user chose and the id of the
 * plan being built).
 * @param {BuilderTurn} turn
 * @param {BuilderTurn['reviewPlan']} reviewPlan
 * @param {boolean} planCurrent
 */
function approvedPlanOf(turn, reviewPlan, planCurrent) {
    const { req, approvedPlanId } = turn;
    if (!req.body.workMode || !approvedPlanId || reviewPlan?.id !== approvedPlanId) return null;
    const buildable = reviewPlan.status === 'review' ? planCurrent : ['paused', 'building'].includes(reviewPlan.status);
    return buildable ? reviewPlan : null;
}

/**
 * What the stored session says about the question round: the card of the
 * previous turn, and the round's memory unless the cycle is over (the plan
 * was rejected or built).
 * @param {BuilderTurn['snapshot']} snapshot
 */
function storedQuestionRound(snapshot) {
    const reviewOutcome = snapshot?.reviewOutcome || null;
    const priorQuestions = Array.isArray(snapshot?.reviewQuestions) && snapshot.reviewQuestions.length ? snapshot.reviewQuestions : null;
    const cycleOver = (reviewOutcome?.kind === 'plan' && reviewOutcome.status === 'rejected') || snapshot?.reviewPlan?.status === 'built';
    const priorMeta = cycleOver ? null : (snapshot?.questionsMeta || null);
    return { reviewOutcome, priorQuestions, priorMeta };
}

/**
 * The question round of a plan: one round per plan cycle, everything asked
 * at once. The cycle starts with the first plan turn after a built, rejected
 * or missing plan and ends when builder_write_plan succeeds. The server
 * remembers that it asked (`questionsMeta` in the snapshot): the model alone
 * did not, and asked again after every answer.
 * @param {BuilderTurn['snapshot']} snapshot
 * @param {string} turnMode
 */
function questionRound(snapshot, turnMode) {
    const { reviewOutcome, priorQuestions, priorMeta } = storedQuestionRound(snapshot);
    const planCycleRound = (turnMode === 'plan' && priorMeta?.mode === 'plan') ? (priorMeta.round || 0) : 0;
    // The previous turn showed the card and this turn is the user's reply
    // (the card's answers or a typed message): the plan follows now.
    const answerTurn = turnMode === 'plan' && !!priorQuestions;
    const questionsClosed = turnMode === 'plan' && (planCycleRound >= 1 || answerTurn);
    return { reviewOutcome, priorQuestions, priorMeta, planCycleRound, answerTurn, questionsClosed };
}

/**
 * The to-do list of the turn (builder_set_plan), carried across turns. The
 * checklist belongs to a build: a list from an earlier turn would tick and
 * spin in Plan first, and its items ("wait for approval") tell an approved
 * build to wait. So: nothing in a planning or discussing turn, and the
 * approved plan's own steps in a build. A paused or continuing build keeps
 * the list it has when it is already that plan's, so its progress survives.
 * @param {BuilderTurn} turn
 * @param {BuilderDraftWrap} draftWrap
 * @param {BuilderTurn['snapshot']} snapshot
 * @param {BuilderTurn['approvedPlan']} approvedPlan
 * @param {string} turnMode
 */
function seedTodos(turn, draftWrap, snapshot, approvedPlan, turnMode) {
    const { req, send } = turn;
    const stored = Array.isArray(snapshot?.todos) ? snapshot.todos : [];
    draftWrap._todos = stored;
    if (approvedPlan) {
        /** @type {string[]} */
        const steps = Array.isArray(approvedPlan.steps) ? approvedPlan.steps.filter(/** @returns {t is string} */ (/** @type {unknown} */ t) => typeof t === 'string') : [];
        const sameList = stored.length === steps.length && steps.every((t, i) => stored[i]?.text === t);
        if (!sameList) draftWrap._todos = steps.map(text => ({ text, done: false }));
        send('plan', { todos: draftWrap._todos });
    } else if (req.body.workMode && (turnMode === 'plan' || turnMode === 'discuss')) {
        draftWrap._todos = [];
        send('plan', { todos: [] });
    }
}

/**
 * A list the prompt renders and a builder tool checks ids against. Two
 * absent shapes, two meanings: null = could not tell (store outage), which
 * is permissive, the same posture as `_availableToolNames`; [] = the user
 * has none, so a step that needs one is refused.
 * @template T
 * @param {string} what
 * @param {() => Promise<T>} read
 * @returns {Promise<T | null>}
 */
async function listOrNull(what, read) {
    try {
        return await read();
    } catch (e) {
        log.warn(`[AutomationBuilder] ${what} catalog unavailable:`, /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * The catalogues of the turn: the apps and tools this user can run, the
 * datatables and designed documents they may address, and the lists the
 * model fills ids from (agents, knowledge bases, app_event providers), each
 * with the canvas pickers' own permission filters. Sets what the builder
 * tools read on the draft wrapper.
 * @param {BuilderTurn} turn
 * @param {BuilderDraftWrap} draftWrap
 * @param {{ snapshot: BuilderTurn['snapshot'], savedProposal: BuilderTurn['savedProposal'], baseDraft: BuilderTurn['baseDraft'],
 *   approvedPlan: BuilderTurn['approvedPlan'], isolated: boolean, permissionMode: string }} state
 */
async function loadCatalogs(turn, draftWrap, { snapshot, savedProposal, baseDraft, approvedPlan, isolated, permissionMode }) {
    const { req, userId, history, message } = turn;
    // (Prompt construction waits until the model is resolved, so the route
    // can pick the full or lean prompt and filter the catalog per model.)
    /** @type {BuilderTurn['catalog']} */
    const catalog = await buildCatalogForUser(userId, req.session);

    // Progressive context: every catalog action's input schema by tool name,
    // so builder_inspect_tool can return exact params on demand and the
    // add-action gate can require an inspect before binding non-trivial
    // params. Built from the catalog's rows and resolved definitions, which
    // buildCatalogForUser has already narrowed to what this user can RUN; it
    // must not be built from the full TOOL_REGISTRY, or `unknownToolError`
    // would read "the catalog knows this tool's schema" as "the user has
    // this tool".
    draftWrap._inputSchemasByTool = inputSchemasByTool(catalog);
    // The authorisation set, deliberately NOT derived from `apps`: a row
    // that could not be built for a tool must not turn into a refusal of a
    // tool the user really has. Nor is `_inputSchemasByTool` the authority:
    // it is keyed on tools that HAVE an input schema.
    /** @type {{ _availableToolNames?: Set<string> | null }} */ (draftWrap)._availableToolNames = catalog?.toolNames instanceof Set ? catalog.toolNames : null;
    // What this session already inspected, narrowed to tools the user can
    // still run; otherwise empty, and the gate asks again this turn.
    draftWrap._inspectedTools = inspectedToolsFrom(/** @type {{ inspectedTools?: unknown } | null} */ (snapshot)?.inspectedTools, draftWrap._availableToolNames);
    // What the draft's tools really returned on this user's last live run
    // (shapeCache), read by the path checks before the curated shapes. One
    // cache read per tool, under a deadline, never an error.
    draftWrap._runtimeShapes = await require('../../../automation/mcpBuilder').loadRuntimeShapes(draftWrap.def, userId);
    // The datatables THIS user may address: the "Datatables you may use"
    // block, and builder_add_datatable's id/key/column check.
    draftWrap._datatables = await listOrNull('datatable', () => require('../../../automation/builderDatatableCatalog').buildDatatableCatalogForUser(userId));
    catalog.datatables = draftWrap._datatables;
    // Tables and consent (builderTools/pendingDatatables, datatableApproval).
    // Set AFTER catalog.datatables above, which stays the plain list, so the
    // cached prompt block does not change when a proposal stages a table;
    // the model learns of staged tables from the review note instead.
    // (setupDatatableTurn's `history = []` default reads as an empty list type.)
    const tableChoice = await setupDatatableTurn({ draftWrap, catalog, req, userId, snapshot, savedProposal, baseDraft, approvedPlan, history: /** @type {never[]} */ (history), message, isolated, permissionMode });

    // The DESIGNED documents this user may fill: the "Documents you may
    // fill" block, and builder_add_fill_document's id/placeholder check.
    draftWrap._documentDiscoveryRequired = true;
    draftWrap._documents = await listOrNull('document', () => require('../../../automation/builderDocumentCatalog').buildDocumentCatalogForUser(userId));
    catalog.documents = draftWrap._documents;

    // Agents, knowledge bases and app_event providers. Each fails into its
    // own "could not read" marker (never into "none"), and none of them
    // throws. They are rendered into the late dynamic message, not the
    // cached system prompt.
    const picked = await require('../../../automation/builderPickerCatalog').buildPickerCatalogsForUser(userId, req.session, catalog);
    Object.assign(catalog, picked);
    draftWrap._blocks = !picked.blocksError && Array.isArray(picked.blocks) ? picked.blocks : null; // call_block's gate; null = could not read
    return { catalog, tableChoice };
}

module.exports = { passesFeatureGate, tiersOfTurn, loadDraftAndSession, approvedPlanOf, questionRound, seedTodos, loadCatalogs };
