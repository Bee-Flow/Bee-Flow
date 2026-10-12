/**
 * App Studio Builder — everything a turn needs BEFORE the stream opens.
 *
 * Reading the request contract, loading the owner's draft, loading the app's
 * data model, and re-attaching the state that survives between turns (the
 * agent's checklist, the brief, the screen constraint). All of it runs
 * pre-SSE on purpose: a rejection here is still clean JSON with a status the
 * client can branch on, not an `error` event inside a 200 stream.
 *
 * The request contract is a zod schema, PARSED here rather than mounted,
 * because the route answers whatever readTurnRequest returns verbatim (see
 * chatStream.js); a refusal carries the same `{ error, code:
 * 'invalid_request', details }` validate() would. Two values were read with a
 * silent default behind them:
 *
 *   - a `planMode` outside auto/always/never became 'auto', so a misspelled
 *     'never' could still stop the build for a plan;
 *   - a `plan` whose action was not exactly 'approve' was no approval: with a
 *     message the turn ran as an ordinary one, and the plan the person had
 *     just edited and approved was silently dropped.
 *
 * Three stay open, each behind its own gate: `context` is whitelisted by
 * sanitizeEditorContext, `images` by sanitizeInboundImages (its sentences and
 * its `invalid_image` code are what the composer shows), and `plan.plan` by
 * boundPlanArtifact.
 *
 * NOT closed here: an unknown `modelTier`. Which tiers this person may use is
 * configuration that modelSelection.js reads, so this synchronous contract
 * cannot know: modelSelection refuses a tier outside that list (403
 * tier_not_permitted). One that is theirs runs on its own model, custom
 * tiers included; with no model configured a built-in tier falls back to the
 * global default model and a custom tier is refused (model_unavailable).
 */

const { z } = require('zod');
const studioAppStore = require('../../../stores/studioAppStore');
const studioAppDataStore = require('../../../stores/studioAppDataStore');
const { canonicalizeAppDefinition } = require('../../../appStudio/canonicalize');
const { emptyDefinition } = require('../../../appStudio/componentSpecs');
const { briefForNaming } = require('../../../appStudio/builderTools/appNaming');
const { describeLinkedTables, overlayLinkedRowCounts } = require('../../../appStudio/linkedTables');
const { normalizePlanTodos } = require('../../../core/llm/planChecklist');
const { deriveScreenConstraints } = require('../../../core/llm/screenConstraints');
const { sanitizeInboundImages } = require('./inboundImages');
const { sanitizeEditorContext } = require('./turnNotes');
const { normalizeRowCounts } = require('./dataModelEvent');

const PLAN_MODES = ['auto', 'always', 'never'];

const TurnBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // Optional: approval, continuation and image-only turns may carry none.
    message: z.string({ invalid_type_error: 'message is the text of your turn.' }).nullish(),
    appId: z.string({ invalid_type_error: 'appId is the id of the app being built.' }).nullish(),
    builderSessionId: z.string({ invalid_type_error: 'builderSessionId must be text.' }).nullish(),
    modelTier: z.string({ invalid_type_error: 'modelTier is the name of a model tier.' }).optional(),
    // Accepted for parity with the other builders; apps carry no time semantics yet.
    timezone: z.string({ invalid_type_error: 'timezone is a zone name, like Europe/Amsterdam.' }).optional(),
    context: z.record(z.unknown(), { invalid_type_error: "context is the editor's focus, an object." }).nullish(),
    planMode: z.enum(PLAN_MODES, { errorMap: () => ({ message: "planMode is 'auto', 'always' or 'never'." }) }).optional(),
    // An APPROVAL turn: inject + persist the approved plan, checkpoint, build.
    plan: z.object({
        planId: z.string({ invalid_type_error: 'plan.planId must be text.' }).optional(),
        action: z.enum(['approve'], { errorMap: () => ({ message: "plan.action is 'approve' — the one thing a turn does with a plan." }) }),
        plan: z.unknown(),
    }, { invalid_type_error: "plan is { planId, action: 'approve', plan }." }).strict().nullish(),
    // Resumes a budget-exhausted plan on the SAME tier (skips the classifier).
    continueToken: z.string({ invalid_type_error: 'continueToken is the token the previous turn handed back.' }).nullish(),
    images: z.unknown(),
}).strict());

/**
 * The turn's request contract: `req.body` → the inputs the rest of the turn
 * reads, or `{ failed: { status, body } }` for the route to answer verbatim.
 */
function readTurnRequest(req) {
    const parsed = TurnBody.safeParse(req.body);
    if (!parsed.success) {
        const details = parsed.error.issues.map((i) => ({ path: ['body', ...i.path].join('.'), message: i.message }));
        return { failed: { status: 400, body: { error: details[0].message, code: 'invalid_request', details } } };
    }
    const body = parsed.data;
    const {
        message,
        appId: requestedAppId,
        builderSessionId: clientSession,
        modelTier = 'auto',
    } = body;
    // Editor context (what the user is looking at) — whitelisted + bounded,
    // rendered as a machine message after the draft state (never persisted).
    const editorContext = sanitizeEditorContext(body.context);

    // ── Wave 5 plan-first UX request contract ──
    //   planMode: 'auto' (default) | 'always' | 'never'
    //   plan: { planId, action:'approve', plan:<possibly-edited artifact> }
    //   continueToken: resumes a budget-exhausted plan on the SAME tier.
    const planMode = body.planMode || 'auto';
    const planApproval = body.plan || undefined;
    const isApproval = !!planApproval;
    const continueToken = body.continueToken || null;

    // ── Inbound user images (screenshots the human is showing the builder).
    //    UNTRUSTED input: validated here, pre-SSE, so a rejection stays clean
    //    JSON; attached ONLY to the role:'user' turn message further down —
    //    never to the (prompt-cached) system prompt. The client's own checks
    //    are a courtesy; THIS is the control. ──
    const imageCheck = sanitizeInboundImages(body.images);
    if (imageCheck.error) {
        return { failed: { status: 400, body: { error: imageCheck.error, code: 'invalid_image' } } };
    }
    const inboundImages = imageCheck.images;

    // Approval/continuation turns carry an implicit instruction when the client
    // sends no prose. Everything else still requires a message — unless the
    // human attached a picture, which is itself the ask ("make it look like
    // this"), so an image-only turn is allowed.
    let effectiveMessage = message;
    if (!effectiveMessage || !effectiveMessage.trim()) {
        if (isApproval) effectiveMessage = 'Build the approved plan.';
        else if (continueToken) effectiveMessage = 'Continue with the next phase of the approved plan.';
        else if (inboundImages.length) effectiveMessage = 'Look at the image(s) I attached.';
        else return { failed: { status: 400, body: { error: 'Message required' } } };
    }
    return {
        message, requestedAppId, clientSession, modelTier, editorContext,
        planMode, planApproval, isApproval, continueToken, inboundImages, effectiveMessage,
    };
}

/**
 * The draft this turn edits (owner-only), plus the persisted builder session
 * it continues. `{ notFound: true }` is the route's pre-SSE 404; a store
 * failure throws and the route answers 500, as it always did.
 */
async function loadDraftWrap(req, { userId, requestedAppId, clientSession }) {
    let draftWrap;
    let priorSnapshot = null;
    if (requestedAppId) {
        const app = await studioAppStore.getStudioApp(requestedAppId);
        if (!app || !studioAppStore.canWriteStudioApp(app, userId)) {
            return { notFound: true };
        }
        // An app a Solution stage manages is changed in Dev and deployed: refuse
        // before any billed turn runs (pre-SSE, so a clean 409 managed_part).
        if (app.projectId) {
            const managedParts = require('../../../stores/lib/managedParts');
            const info = await managedParts.managedInfo(app.projectId);
            if (info) throw managedParts.managedPartError(info);
        }
        const { def } = canonicalizeAppDefinition(
            app.definition && Object.keys(app.definition).length ? app.definition : emptyDefinition(app.name),
        );
        priorSnapshot = await studioAppStore.getBuilderSession(app.id, userId).catch(() => null);
        draftWrap = {
            userId,
            orgId: app.organizationId || req.session?.user?.organizationId || null,
            appId: app.id,
            version: app.definitionVersion,
            builderSessionId: clientSession || priorSnapshot?.sessionId || `as_${Date.now().toString(36)}`,
            def,
        };
    } else {
        draftWrap = {
            userId,
            orgId: req.session?.user?.organizationId || null,
            appId: null,
            version: null,
            builderSessionId: clientSession || `as_${Date.now().toString(36)}`,
            def: emptyDefinition('Untitled app'),
        };
    }
    return { draftWrap, priorSnapshot };
}

/**
 * The app's data model + dataset ids, onto the draftWrap. Best-effort: the
 * caller swallows a store failure and the data-reference checks are skipped
 * for this turn (never a 500).
 */
async function loadTurnDataModel(draftWrap, userId) {
    if (draftWrap.appId) {
        const dataMeta = await studioAppDataStore.getDataModel(draftWrap.appId, userId);
        draftWrap.dataModel = dataMeta?.model ?? null;
        draftWrap.dataModelVersion = dataMeta?.modelVersion ?? 0;
        draftWrap.rowCounts = normalizeRowCounts(draftWrap.dataModel, dataMeta?.rowCounts);
        const datasetRows = await studioAppDataStore.listDatasets(draftWrap.appId, userId);
        draftWrap.datasetIds = (datasetRows || []).map((d) => ({ id: d.id, name: d.name }));
        // Tables whose rows live in a Studio datatable (a Nextcloud mirror,
        // an org table): what they are and how many LIVE rows they hold —
        // the per-app recount above says 0 for them. Lazy: an app with no
        // linked table never touches the datatable stores.
        draftWrap.linkedTables = await describeLinkedTables(draftWrap.dataModel, userId);
        draftWrap.rowCounts = overlayLinkedRowCounts(draftWrap.rowCounts, draftWrap.linkedTables);
    } else {
        // Fresh app: no database yet — any table/dataset reference is a
        // real error the validation loop should catch.
        draftWrap.dataModel = null;
        draftWrap.dataModelVersion = 0;
        draftWrap.rowCounts = {};
        draftWrap.datasetIds = [];
        draftWrap.linkedTables = new Map();
    }
    // The owner's Studio tables — the same list the publish gate and
    // app_finalize use. With it a `source.datatableId` that points nowhere
    // is an ERROR the model is told about while it still has rounds left;
    // without it every binding on a linked table came back as the
    // unactionable warning `binding.datatable_unverified`.
    draftWrap._ownerDatatables = await require('../../../appStudio/datatableSource').listOwnerDatatableIds(userId);
}

/** The state that survives between turns, re-attached to the draftWrap. */
function attachCrossTurnState(draftWrap, { priorSnapshot, message }) {
// The agent's own checklist (app_set_plan) survives across turns on the
// snapshot, so a follow-up turn — or a refresh — shows the same list the
// model is ticking, and the progress inference has something to tick.
draftWrap._todos = Array.isArray(priorSnapshot?.todos) ? normalizePlanTodos(priorSnapshot.todos) : [];
draftWrap._turnMessage = briefForNaming(priorSnapshot?.messages, message, priorSnapshot?.brief); // the brief (first human message), for the finalize-time naming net
// What the person said about the app's SCREENS ("only a dashboard", "one
// screen", "no detail page"): THIS turn's words first — "add a detail
// page" on a later turn lifts the rule — else the brief's. The add-screen
// guard in definitionTools reads it; a rule in the prompt alone lost to
// the model's habit of adding a detail screen (playbooks, 2026-09-18).
draftWrap._screenConstraint = deriveScreenConstraints(message) || deriveScreenConstraints(draftWrap._turnMessage) || null;
}

module.exports = { readTurnRequest, loadDraftWrap, loadTurnDataModel, attachCrossTurnState };
