// @typecheck
/**
 * Direct Chat — the setup phases of a streamed turn, in pipeline order, up to
 * the input gates: tool stack, prompt + history, document scope, the
 * shared-thread claim, session skills, the stage model swap, attachment
 * intake and the memory token swap. Split out of streamTurn.js; behaviour
 * unchanged. Every phase writes its result onto the shared TurnState.
 *
 * Returns false when a phase already ended the stream (the shared thread is
 * busy, or the Privacy Shield blocked an attachment): the turn must stop.
 */

const log = require('../../../telemetry/log');
const { assembleToolStack } = require('./toolStackAssembly');
const { buildPromptAndHistory, applyMemorySwap } = require('./promptAssembly');
const { setupSessionSkills } = require('./sessionSkillSetup');
const { claimSharedThreadTurn } = require('./sharedThreadLock');
const { swapModelForActiveStage } = require('./stageModelSwap');
const { processAttachmentsAndUserMessage } = require('./attachmentIntake');

async function runSetupPhases(turn, body) {
    const { req, send, userId } = turn;
    const {
        message, conversationId, modelTier, history, attachments, disabledMedia, webSearchEnabled,
        notebookspaceContent, notebookspaceSelection, notebookspaceAvailable, sidePanelWebpage, sidePanelDocument,
        projectId, timezone, requestSystemPrompt, activeSkillIds, requestSessionSkills, requestActivatedSessionSkillIds,
        requestedKbIds, webpagePlanExecution,
    } = body;

    Object.assign(turn, await assembleToolStack({
        req, send, userId, conversationId, resolvedTier: turn.resolvedTier, attachments, history, disabledMedia,
        webSearchEnabled, disableSearchOnUpload: turn.disableSearchOnUpload, message, notebookspaceContent,
        activeSkillIds, userOrgForTiers: turn.userOrgForTiers,
    }));

    // `usableKbIds` = the attached knowledge bases this turn was actually
    // ALLOWED to search (client list ∩ kbVisibility ∩ usage_contexts).
    // finalizeTurn persists exactly that, never the raw client list.
    Object.assign(turn, await buildPromptAndHistory({
        req, send, userId, message, conversationId, history, timezone, requestSystemPrompt, activeSkillIds,
        requestedKbIds, projectId, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection,
        sidePanelWebpage, sidePanelDocument, webpagePlanExecution, userOrgForTiers: turn.userOrgForTiers,
        orgIdsForTiers: turn.orgIdsForTiers, notebooksEnabled: turn.notebooksEnabled,
        canUseNotebooks: turn.canUseNotebooks, toolCatalogText: turn.toolCatalogText,
        directChatTools: turn.directChatTools,
    }));

    // What the document tools may touch this turn: the open document, what
    // this chat made, what the person's own messages point at.
    turn.documentScope = require('../../../core/documents/aiDocumentScope').createDocumentScope({
        sidePanelDocument, history: turn.resolvedHistory, message,
    });

    const claimedThread = await claimSharedThreadTurn(turn);
    if (!claimedThread) return false;

    Object.assign(turn, await setupSessionSkills({
        req, send, userId, convId: turn.convId, config: turn.config,
        clientHistoryProvided: turn.clientHistoryProvided, modelId: turn.modelId,
        disableSearchOnUpload: turn.disableSearchOnUpload, directChatTools: turn.directChatTools,
        resolvedTier: turn.resolvedTier, requestSessionSkills, requestActivatedSessionSkillIds, message, timezone,
        tier: turn.tier, adapter: turn.adapter, apiKey: turn.apiKey, apiUrl: turn.apiUrl,
        messages: turn.messages, volatileMessage: turn.volatileMessage,
    }));

    // Reassigns the turn's model/adapter when a Flow stage asked for its own
    // tier; bound here because the tool dispatcher calls it too.
    turn.swapModelForActiveStage = () => swapModelForActiveStage(turn);
    // Run once at the start so a step-1 stage with a tier override picks its
    // model before the first LLM round.
    await turn.swapModelForActiveStage();
    const attachmentIntake = await processAttachmentsAndUserMessage({
        req, res: turn.res, send, userId, convId: turn.convId, conversationId, modelTier, message, attachments,
        adapter: turn.adapter, modelId: turn.modelId, config: turn.config, messages: turn.messages, documentScope: turn.documentScope,
    });
    if (!attachmentIntake) return false;
    Object.assign(turn, attachmentIntake);
    try { await applyMemorySwap(turn, userId); } catch (e) { log.warn('[DirectChat] Memory token swap failed (labels stay):', /** @type {Error} */ (e).message); }

    // NOTE: a previous block here tried to inject TERMINAL_TOOLS
    // (convert_document_to_text, etc.) via require('../../terminal/tools')
    // when Gmail/Drive tools were present. That module does not exist, so the
    // require always threw MODULE_NOT_FOUND and the catch silently swallowed
    // it: dead code that injected nothing, which also let the model believe a
    // generic document-conversion tool existed. Removed. The real
    // path for Gmail attachments is gmail_read_attachment; the system prompt
    // steers the model there (see GMAIL/ATTACHMENT note).
    return true;
}

module.exports = { runSetupPhases };
