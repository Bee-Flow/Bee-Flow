/**
 * App Studio Builder — the prompt for one turn.
 *
 * The capability profile for the chosen model, the owner's catalog (routines +
 * designed documents, which the core tool menu has no list tools for), the
 * system prompt, the tool menu, and the folded user message the round is
 * actually sent.
 *
 * PROMPT-CACHE DISCIPLINE: the system prompt is byte-stable across turns —
 * every per-turn fact (draft state, approved plan, editor context, the blind-
 * image note) rides INSIDE the single user message instead, so a provider
 * prefix cache keeps hitting while the user iterates. The one log line prints
 * the prefix digests so two consecutive turns can be compared with grep.
 */

const configStore = require('../../../stores/configStore');
const { boundPlanArtifact } = require('../../../appStudio/builderTools');
const { buildSystemPrompt, renderOwnerContextNote } = require('../../../appStudio/builderPrompt');
const { getProfileForModel, selectToolMenu } = require('../../../appStudio/builderModelProfiles');
const { TOOL_SCHEMAS } = require('../../../appStudio/builderTools');
const { systemPrefixFingerprint, toolSetFingerprint, toolBytesFingerprint } = require('../../../core/llm/promptCacheStability');
const { sanitizeHistory } = require('./turnLoop');
const { composeAppTurnMessages } = require('./turnMessages');
const { renderDraftStateNote, renderApprovedPlanNote, renderPlanPolicyNote, renderEditorContextNote } = require('./turnNotes');
const { renderBlindImageNote, renderUserImageFraming, renderVisionUnsupportedNotice } = require('./inboundImages');
const log = require('../../../telemetry/log');

/**
 * Everything the build loop reads about "what the model is being asked":
 * { profile, sys, tools, toolNameSet, history, approvedPlanForTurn, composed,
 * messages }. Mutates the draftWrap with the keyed owner catalogs the tools
 * check against at write time.
 */
async function assembleTurnPrompt({
    send, userId, modelId, resolvedTier, draftWrap, priorSnapshot, isApproval, planApproval, planMode,
    editorContext, inboundImages, modelSupportsVision, effectiveMessage,
}) {
    // Capability profile for this model — with the admin override map
    // `builder_model_profiles` ({ "<modelId>": {band, temperature, …} })
    // the routine builder already honours. Without it the configured
    // Gemma temperature was silently replaced by the band default.
    let profileOverrides = null;
    try {
        const raw = await configStore.getConfig('builder_model_profiles');
        profileOverrides = raw && typeof raw === 'object' ? raw
            : (typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : null);
    } catch (_) { profileOverrides = null; }
    const profile = getProfileForModel(modelId, profileOverrides);
    log.info(`[AppStudioBuilder] model=${modelId} tier=${resolvedTier} profile=${JSON.stringify(profile)}`);

    // Owner's routines — rendered into the OWNER CONTEXT machine note of
    // the folded user message (renderOwnerContextNote; out of the system
    // prompt since 2026-09-17 so the prefix is one text for every user).
    // Best-effort.
    let automationRows = [];
    try {
        const automationStore = require('../../../stores/automationStore');
        const rows = await automationStore.getAutomationsForUser(userId);
        automationRows = (rows || []).slice(0, 100).map((a) => {
            const trigger = a?.definition?.trigger || {};
            const kind = trigger.kind || a.triggerType || 'manual';
            const row = {
                id: a.id,
                title: a.title,
                description: typeof a.description === 'string' ? a.description.slice(0, 140) : '',
                isActive: !!a.isActive,
                trigger: kind,
            };
            if (kind === 'agent_call') {
                const props = trigger.parametersSchema?.properties;
                row.params = props && typeof props === 'object' ? Object.keys(props) : [];
            }
            return row;
        });
        // The same list, keyed, for the tool-time check in app_set_action:
        // a run_automation naming a routine the owner does not have is
        // refused when it is written, not at finalize.
        draftWrap._ownedAutomations = new Map((rows || []).map((a) => [a.id, { isActive: !!a.isActive }]));
    } catch (_) { /* prompt renders the empty-state line */ }

    // Owner's designed documents — rendered into the same note, and for the
    // same reason: the core tool menu has no list tools, so a document a
    // small model cannot discover is one it invents an id for.
    let documentRows = [];
    draftWrap._documentDiscoveryRequired = true;
    try {
        const { buildDocumentCatalogForUser } = require('../../../automation/builderDocumentCatalog');
        documentRows = await buildDocumentCatalogForUser(userId);
        // The keyed list for the tool-time check: a fill_document naming a
        // document the owner does not have is refused when it is written.
        draftWrap._documents = documentRows;
    } catch (_) { /* prompt renders the empty-state line; the gate stays permissive */ }

    const sys = buildSystemPrompt({
        toolset: profile.toolset === 'core' ? 'core' : 'full',
        catalogMode: profile.catalogMode === 'filtered' ? 'filtered' : 'full',
        ownerContext: 'note', // the owner's routines/documents ride the per-turn OWNER CONTEXT note below
    });

    // Tool menu keys off the capability profile: small models get the
    // reduced core subset; every capable model (Claude-4.5-class and up)
    // gets the FULL menu, app_screenshot included.
    const tools = selectToolMenu(profile, TOOL_SCHEMAS);
    const toolNameSet = new Set(tools.map((t) => (t && t.function && t.function.name) || t.name).filter(Boolean));

    // Prior conversation from the persisted snapshot (server-owned — the
    // client does not resend history). Few-shot policy and the history
    // window are the compose site's (composeAppTurnMessages).
    const history = sanitizeHistory(priorSnapshot?.messages);

    // Live draft state (+ data block) and the other machine notes ride
    // INSIDE the single user message (never in the cached system prompt;
    // see the cache-discipline note at the top).
    // ── Wave 5: the approved plan travels as a machine message EVERY turn
    //    until the build finalizes. On an approval turn it comes from the
    //    (possibly-edited) artifact in the body; on later turns it is
    //    re-rendered from the persisted approvedPlan (fixes plan amnesia —
    //    the approval-turn injection alone is stripped from history next
    //    turn, so without re-rendering the model forgets the plan). ──
    let approvedPlanForTurn = null;
    if (isApproval) {
        const bounded = boundPlanArtifact(planApproval.plan || {});
        approvedPlanForTurn = (!bounded.error && bounded.plan)
            || priorSnapshot?.pendingPlan?.plan
            || priorSnapshot?.approvedPlan
            || null;
    } else {
        approvedPlanForTurn = priorSnapshot?.approvedPlan || null;
    }

    const contextNote = renderEditorContextNote(editorContext);
    const approvedPlanNote = approvedPlanForTurn ? renderApprovedPlanNote(approvedPlanForTurn) : null;
    const planPolicyNote = renderPlanPolicyNote(planMode);

    // ── The human's attached image(s). Vision-capable models get them as
    //    image content blocks on the USER turn message (the same
    //    { type:'image_url' } shape app_screenshot uses on its way to the
    //    model, so one adapter code path serves both). A blind model gets
    //    a machine note instead, and the user is told plainly in the
    //    stream that the picture was ignored — never a silent drop. ──
    const blindToImages = inboundImages.length > 0 && !modelSupportsVision;
    if (blindToImages) {
        send('message', { content: renderVisionUnsupportedNotice(inboundImages.length, modelId) });
    }
    const imageNote = blindToImages ? renderBlindImageNote(inboundImages.length) : null;
    const userTurnContent = (inboundImages.length && modelSupportsVision)
        ? [
            { type: 'text', text: String(effectiveMessage) },
            ...inboundImages.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
            { type: 'text', text: renderUserImageFraming(inboundImages.length) },
        ]
        : String(effectiveMessage);

    const composed = composeAppTurnMessages({
        profile, modelId, sys,
        history: priorSnapshot?.messages,
        notes: [renderDraftStateNote(draftWrap.def, draftWrap), renderOwnerContextNote(automationRows, documentRows), approvedPlanNote, contextNote, planPolicyNote, imageNote],
        userTurnContent,
    });
    const { messages } = composed;
    // Proof for the box: identical digests on two consecutive turns mean
    // the prefix cache holds; a moving `sys` names the culprit. `tools`
    // hashes the NAMES (menu identity), `toolBytes` the serialised schemas
    // — a description edit moves only the second. `fewShots` is a hash of
    // the bytes, like the routine builder's line, so two sessions can be
    // compared with grep.
    log.info(`[AppStudioBuilder] prefix sys=${systemPrefixFingerprint(sys)} tools=${toolSetFingerprint(tools)} toolBytes=${toolBytesFingerprint(tools)} fewShots=${systemPrefixFingerprint(JSON.stringify(composed.fewShotMessages))} n=${composed.fewShotMessages.length} history=${composed.windowedHistory.length}`);
    return { profile, sys, tools, toolNameSet, history, approvedPlanForTurn, composed, messages };
}

module.exports = { assembleTurnPrompt };
