// @typecheck noImplicitAny
/**
 * Automation Builder — the turn's prompt: the catalogue in the profile's
 * order, the pre-inspected tool schemas, the web-research decision and the
 * composed messages ([system] [few-shots] [history window] [dyn] [user]),
 * plus the work-mode instruction. Moved verbatim from ./chatStream.js.
 */

const log = require('../../../telemetry/log');
const { rankAppsForMessage, applyCatalogOrder, catalogOrderOf } = require('../../../automation/builderPrompt/rankApps');
const { resolveWebResearch, webResearchPromptLine } = require('./webResearch');
const { LARGE_CHANGE_STEPS, modeInstruction, reviewStatusNote, questionStatusNote } = require('./workMode');
const { composeTurnMessages } = require('./turnMessages');

// Catalog ORDERING for profiles that ask for it — see
// automation/builderPrompt/rankApps.js. It used to be a catalog FILTER, and
// that is what put `nextcloud_calendar_list` into an invoice automation:
//
//   - the substring matcher returned true for all 17 apps (every app id
//     contains "nextcloud"; stop words like "the" match some description
//     everywhere), so `.slice(0, 8)` kept the first eight in REGISTRY order —
//     memory, automation-evolution, kb-ingest, nextcloud, calendar, contacts,
//     deck, talk. `nextcloud-notifications` and `nextcloud-tables` were cut
//     even when the brief named them, and stayed cut when the user replied
//     "use Nextcloud Notifications, not the calendar";
//   - a short reply ("ok", "yes", "fix it") matched NOTHING, so the prompt
//     told the model `_(user has no integrations connected)_` — on a turn
//     where forceFirstToolCall makes a tool call mandatory;
//   - and because the surviving set was derived from the message, the system
//     prompt mutated every turn, invalidating the prefix cache the comment
//     below promises (~21k tokens re-prefilled per turn on the local box).
//
// Relevance now orders the catalogue and never removes from it, so none of
// those failure modes has anywhere to live.

/**
 * @param {import('./turnSetup').BuilderTurn} turn
 */
async function assembleTurnPrompt(turn) {
    const {
        req, send, userId, message, history, attachments, webSearchEnabled, disabledMedia, timezone, canvasScope,
        pauseAfterStep, selectedStepId, codeStepEnabled, userOrgForTiers, draftWrap, reviewPlan, planCurrent,
        approvedPlan, turnMode, bufferedBuild, isolated, baseDraft, savedProposal, reviewOutcome, priorQuestions,
        storedCatalogOrder, catalog, tableChoice, agentDraftState, modelId, profile,
    } = turn;
    // The catalogue in the profile's order. 'filtered' is a misnomer kept
    // for the profile field: relevance ORDERS the catalogue, it never
    // removes anything from it (rankApps.js).
    //
    // The order is chosen ONCE per session and replayed. rankAppsForMessage
    // scores against THIS message and pins the apps the draft uses, so its
    // output changed on every reply and as steps were added — and the
    // catalogue is rendered into the system prompt, the front of the prompt
    // cache. A session with a stored order never consults the reranker
    // again; the first turn (no snapshot yet) still ranks, and the result is
    // persisted with the builder session below.
    const promptCatalog = profile.catalogMode !== 'filtered'
        ? catalog
        : storedCatalogOrder
            ? applyCatalogOrder(catalog, storedCatalogOrder)
            : await rankAppsForMessage(catalog, message, draftWrap.def);
    const catalogOrder = profile.catalogMode === 'filtered' ? catalogOrderOf(promptCatalog) : null;

    // Pre-inspected schemas for the tools relevant to this message/draft
    // (§WS8 — makes zero inspect rounds the common case). Part of the
    // per-turn dynamic message, never of the system prompt.
    const def0 = draftWrap.def || {};
    const draftIsEmpty = !def0.trigger
        && !(Array.isArray(def0.steps) && def0.steps.length)
        && !Object.keys(def0.layers || {}).length;
    /** @type {string | null} */
    let schemaPart = null;
    if (profile.schemaInjection) {
        try {
            // FULL catalog (permission-gated upstream by buildCatalogForUser),
            // not the small-profile filtered one.
            const { renderRelevantToolSchemas } = require('../../../automation/builderPrompt/catalogRender');
            const relevant = renderRelevantToolSchemas(catalog, message, draftWrap.def, { max: 10 });
            if (relevant) {
                schemaPart = relevant.text;
                for (const t of relevant.tools) draftWrap._inspectedTools.add(t);
            }
        } catch (e) { log.warn('[AutomationBuilder] schema injection skipped:', /** @type {Error} */ (e).message); }
    }

    // The composer's Web search toggle: whether the builder model ITSELF
    // may search this turn, behind the gates direct chat uses. The client
    // hears the answer so a toggle that cannot work says why.
    const webResearch = await resolveWebResearch({
        requested: !!webSearchEnabled, userId, orgId: userOrgForTiers,
        session: req.session, isAdmin: !!req.session?.isAdmin, attachments, history,
    });
    send('web_search', { requested: !!webSearchEnabled, available: webResearch.offered, reason: webResearch.reason });

    // Compose the turn: [system] [few-shots] [history window] [dyn] [user].
    // Everything before `dyn` is a pure function of session state, so the
    // prompt-prefix cache survives from one user turn to the next; the
    // draft state, pre-inspected schemas and this turn's preferences
    // (timezone, web search, disabled media, allowed tiers — all read per
    // request) ride in the late dynamic message. See turnMessages.js.
    const { sys, fewShotMessages, windowedHistory, messages } = composeTurnMessages({
        profile, modelId, promptCatalog, codeStepEnabled,
        history, message, attachments,
        agentDraftState, draftIsEmpty, canvasScope, schemaPart,
        workMode: req.body.workMode ? turnMode : null,
        // The draft-state message opens with the name, or with the fact
        // that there is none yet (renderDraftStateSystemMessage).
        title: draftWrap.title,
        turnPrefs: {
            userTimezone: timezone || 'Europe/Amsterdam',
            webSearchEnabled: !!webSearchEnabled,
            webResearchLine: webResearchPromptLine(webResearch),
            disabledMedia: disabledMedia || {},
            // The ONLY ai_step modelTier values this user has (validated
            // server-side by modelTierGateError as well).
            allowedModelTiers: [...draftWrap._allowedModelTiers],
        },
    });

    if (req.body.workMode) messages.push({ role: 'system', content: modeInstruction(turnMode, approvedPlan) + (bufferedBuild ? `\nChanges are staged to check their size. Fewer than ${LARGE_CHANGE_STEPS} changed steps are applied at the end of this turn; ${LARGE_CHANGE_STEPS} or more become a proposal the user applies with one click. Do not claim staged changes are applied. You may dry-run them: the run uses the staged definition and saves nothing.` : '') + reviewStatusNote({ outcome: reviewOutcome, pending: savedProposal, isolated, liveDef: baseDraft, choice: tableChoice, plan: turnMode === 'plan' ? reviewPlan : null, planCurrent }) + questionStatusNote({ prior: priorQuestions, answeredText: message, mode: turnMode, approvedPlan }) + (approvedPlan && pauseAfterStep ? '\nPause after ONE step change. Avoid batches; the user must explicitly continue before the next step. Read the current draft to avoid repeating completed changes.' : '') + (selectedStepId ? `\nThe user's selected step is ${selectedStepId}. Resolve its label and settings from the draft above.` : '') });

    Object.assign(turn, { catalogOrder, webResearch, sys, fewShotMessages, windowedHistory, messages });
}

module.exports = { assembleTurnPrompt };
