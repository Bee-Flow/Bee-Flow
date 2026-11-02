// @typecheck
/**
 * Streaming agent chat — end-of-turn finalization.
 *
 * Runs once the model stops calling tools: strip stray tool-call XML /
 * think tags, build the assistant message with its persisted metadata
 * (drafts, tool history, thinking parts, KB sources, tokenisation info),
 * persist the turn (with this turn's user message already in its redacted
 * form), kick off memory extraction and emit the raw-payload transparency event. Returns
 * the turn's result object. The message's extras (markup strip, token
 * restore, thinking, tokenisation info) live in ./assistantMessageExtras.
 */
const { featureModule } = require('../featureModules');
const log = require('../../telemetry/log');
const { resolveMemoryPolicy } = require('../memory/memoryPolicy');
const { persistedMemoryUsed } = require('../memory/memoryUsed');
const {
    stripToolCallMarkup, restoreToolHistoryTokens, persistedThinking, synthesiseTokenisationInfo,
} = require('./assistantMessageExtras');
const { bestEffort } = require('../../utils/bestEffort');

// The PII detector and the DLP runner, lazily, for ./assistantMessageExtras
// (which stays out of the server's large import cycle).
const PRIVACY = {
    piiDetection: () => require('../privacy/piiDetection'),
    dlpRunner: () => require('../dlp/dlpRunner'),
};

async function finalizeStreamTurn(turn) {
    const {
        useNativeAdapter, onEvent, conversation,
        _captureRaw, _rawResponseBuffer, _userPrivacyMeta, userSave, durableMessages,
        messages, persistDurable, isEphemeral, guardrailViolation, modelToUse, toolCalls,
    } = turn;
    const fullResponse = stripToolCallMarkup(turn.fullResponse, { useNativeAdapter, onEvent });

    // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed
    // when the Azure Content Safety backend was dropped. PII detection
    // runs via the GLiNER guard service, streamed through
    // `untokeniseStream` rather than gated here.

    const assistantMsg = buildAssistantMessage(turn, fullResponse);

    // Privacy / DLP — on turns where no new redaction fires, surface the
    // restored tokens or the conversation vault instead (see
    // synthesiseTokenisationInfo).
    let _assistantTokenisationInfo = turn._assistantTokenisationInfo;
    if (!_assistantTokenisationInfo) {
        _assistantTokenisationInfo = synthesiseTokenisationInfo({ ut: turn._ut, conversation, modelToUse, onEvent }, PRIVACY);
    }
    if (_assistantTokenisationInfo) {
        if (_captureRaw && _rawResponseBuffer) {
            _assistantTokenisationInfo.rawResponse = _rawResponseBuffer;
            _assistantTokenisationInfo.rawTruncated = _rawResponseBuffer.endsWith('…');
        }
        assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
    }
    // Direct reference instead of a reverse scan: on a compacted turn the
    // scan could land on compaction's SYNTHETIC "[Original request …]"
    // user message rather than the real one.
    if (_userPrivacyMeta && userSave) {
        Object.assign(userSave, _userPrivacyMeta);
    }
    // The redacted form is part of the same write as the turn: the stored
    // user message never holds the unredacted text.
    if (!isEphemeral) applyStoredRedaction(userSave, turnRedactedContent(turn), '[RegexGuard]');
    durableMessages.push(assistantMsg);
    messages.push(assistantMsg);
    await persistDurable();

    // Skip for ephemeral embed chats.
    if (!isEphemeral) {
        await scheduleMemoryExtraction(turn);
    }

    // Transparency: emit the accumulated raw (pre-un-tokenise) LLM
    // response once per turn, gated by the org's `showRawPayload` toggle,
    // so the "How I got this answer" panel receives it on the agent-chat path.
    if (_captureRaw && _rawResponseBuffer) {
        onEvent?.('privacy_response_raw', {
            rawResponse: _rawResponseBuffer,
            truncated: _rawResponseBuffer.endsWith('…'),
            timestamp: Date.now(),
        });
    }

    return {
        message: fullResponse,
        toolCalls,
        conversationLength: durableMessages.length,
        conversationId: conversation.id,
        guardrailViolation: guardrailViolation || null,
        // The stored user message is the redacted form, not what was typed.
        userMessageRedacted: turn.processedUserMessage !== turn.userMessage,
        model: modelToUse,
    };
}

/**
 * The assistant message with its persisted metadata, before tokenisation info.
 * @param {string} fullResponse
 */
function buildAssistantMessage(turn, fullResponse) {
    const {
        messageMetadata, conversation, _emailDrafts, _calendarDrafts, _linkedInDrafts, _mapEmbeds,
        _audioFiles, _generatedFiles = [], _pendingToolCalls = [], _toolHistory, _kbSources,
        _thinkingParts, _thinking, memoryUsed,
    } = turn;
    // Include parentId for thread persistence
    const assistantMsg = {
        role: 'assistant',
        content: fullResponse,
        parentId: messageMetadata.parentId || null,
    };

    // Attach persisted metadata
    if (_emailDrafts.length > 0) assistantMsg.emailDrafts = _emailDrafts;
    if (_calendarDrafts.length > 0) assistantMsg.calendarDrafts = _calendarDrafts;
    if (_linkedInDrafts.length > 0) assistantMsg.linkedInDrafts = _linkedInDrafts;
    if (_mapEmbeds.length > 0) assistantMsg.mapEmbeds = _mapEmbeds;
    if (_audioFiles.length > 0) assistantMsg.audioFiles = _audioFiles;
    if (_generatedFiles.length > 0) assistantMsg.files = _generatedFiles;
    // Tool calls held back for approval — same carrier as the drafts
    // above, so a reload shows the pending action and a client that
    // does not know the field simply ignores it.
    if (_pendingToolCalls.length > 0) assistantMsg.pendingToolCalls = _pendingToolCalls;
    if (_toolHistory.length > 0) {
        restoreToolHistoryTokens(_toolHistory, conversation, PRIVACY);
        assistantMsg.toolHistory = _toolHistory;
    }
    if (_kbSources.length > 0) assistantMsg.kbSources = _kbSources;
    // Memories injected into this turn (ids and types only, never their
    // text), so the "used memory" chip survives a reload.
    if (Array.isArray(memoryUsed) && memoryUsed.length > 0) assistantMsg.memoryUsed = persistedMemoryUsed(memoryUsed);
    const thinking = persistedThinking(_thinkingParts, _thinking, conversation, PRIVACY);
    if (thinking !== undefined) assistantMsg.thinking = thinking;
    return assistantMsg;
}

/**
 * MEMORY EXTRACTION — fire-and-forget, skipped on a guardrail violation or a
 * redaction.
 *
 * The gate (user/org switch, embed agent, per-chat toggle) was resolved once
 * in the preflight; fall back to resolving here for a caller that has no
 * preflight. Guardrail and redaction only exist by now, so they are applied
 * as `blocked`.
 */
async function scheduleMemoryExtraction(turn) {
    const {
        messageMetadata, agent, agentId, userId, conversation, guardrailViolation,
        processedUserMessage, userMessage, messages, durableMessages, onEvent,
        extractMemoriesEnabled, validProjectId, memoryPolicy,
    } = turn;
    const blocked = !!guardrailViolation || processedUserMessage !== userMessage;
    const policy = memoryPolicy || await resolveMemoryPolicy({
        userId, orgId: messageMetadata?.userOrgId || agent.organization_id || null, agent,
        perChatReadEnabled: messageMetadata?.memoryReadEnabled,
        perChatWriteEnabled: messageMetadata?.memoryWriteEnabled,
    });
    const memoryWriteEnabled = policy.write;
    const shouldSkipMemoryExtraction = !policy.write || blocked;

    const debugData = {
        agentId,
        conversationId: conversation.id,
        guardrailViolation: !!guardrailViolation,
        isRedacted: processedUserMessage !== userMessage,
        memoryWriteEnabled,
        shouldSkip: shouldSkipMemoryExtraction,
        messagesCount: messages.length,
        userMessageLength: userMessage.length,
    };
    log.info(`[DEBUG] Memory Extraction Check:`, debugData);

    if (shouldSkipMemoryExtraction) {
        log.info(`[AgentRuntime] Skipping memory extraction (${policy.write ? 'guardrail violation or redaction' : policy.reason})`);
        return;
    }
    try {
        const memoryExtractor = featureModule('agents/memory/extractor');
        memoryExtractor.extractFromConversation(userId, agentId, durableMessages, conversation.id, extractMemoriesEnabled ? validProjectId : null, messageMetadata?.userOrgId || null)
            .then(extracted => {
                if (extracted.length > 0) {
                    log.info(`[AgentRuntime] Extracted ${extracted.length} memories from conversation`);
                }
            })
            .catch(err => {
                log.error('[AgentRuntime] Memory extraction failed:', err.message);
                // Surface to the client so operators can see persistent extraction
                // failures rather than silently losing all memory writes.
                try { onEvent('memory_extraction_failed', { error: err.message }); } catch (err) { bestEffort('core/agentRuntime/finalizeTurn:scheduleMemoryExtraction', err); /* ignore */ }
            });
    } catch (memErr) {
        log.error('[AgentRuntime] Memory extractor load failed:', /** @type {Error} */ (memErr).message);
    }
}

/**
 * REDACTION OF THE STORED USER MESSAGE — for both delete mode
 * (guardrailViolation) and redact mode (processedUserMessage changed): the
 * content this turn's user row is stored with, or null when it is stored as
 * typed.
 * @param {{ guardrailViolation?: unknown, processedUserMessage: string, userMessage: string }} turn
 * @returns {string | null}
 */
function turnRedactedContent({ guardrailViolation, processedUserMessage, userMessage }) {
    if (processedUserMessage !== userMessage) return processedUserMessage; // redacted version (with [REDACTED: RuleName])
    return guardrailViolation ? '[Message removed - policy violation]' : null; // full replacement for delete mode
}

/**
 * Put the redacted content on this turn's user row BEFORE the turn is
 * persisted, so the redaction lands in the same write as the turn instead of a
 * second write after it. This turn's own row, never "the last user message" of
 * a re-read conversation, which may be another turn's. Shared with the
 * guardrail hard block (./guardrailHardBlock.js).
 * @param {Record<string, unknown> | null | undefined} userSave
 * @param {string | null} redactedContent
 * @param {string} tag
 */
function applyStoredRedaction(userSave, redactedContent, tag) {
    if (redactedContent === null) return;
    if (!userSave) {
        log.warn(`${tag} No user message found for redaction`);
        return;
    }
    userSave.content = redactedContent;
    userSave.isRedacted = true;
}

module.exports = { finalizeStreamTurn, applyStoredRedaction, turnRedactedContent };
