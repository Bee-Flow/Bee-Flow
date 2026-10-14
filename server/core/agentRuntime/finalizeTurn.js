/**
 * Streaming agent chat — end-of-turn finalization.
 *
 * Runs once the model stops calling tools: strip stray tool-call XML /
 * think tags, build the assistant message with its persisted metadata
 * (drafts, tool history, thinking parts, KB sources, tokenisation info),
 * persist the turn, kick off memory extraction, schedule the server-side
 * redaction re-write and emit the raw-payload transparency event. Returns
 * the turn's result object. The message's extras (markup strip, token
 * restore, thinking, tokenisation info) live in ./assistantMessageExtras.
 */
const agentStore = require('../../stores/agentStore');
const log = require('../../telemetry/log');
const { resolveMemoryPolicy } = require('../memory/memoryPolicy');
const { persistedMemoryUsed } = require('../memory/memoryUsed');
const {
    stripToolCallMarkup, restoreToolHistoryTokens, persistedThinking, synthesiseTokenisationInfo,
} = require('./assistantMessageExtras');

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
    durableMessages.push(assistantMsg);
    messages.push(assistantMsg);
    await persistDurable();

    // Skip for ephemeral embed chats.
    if (!isEphemeral) {
        await scheduleMemoryExtraction(turn);
        scheduleRedactionRewrite(turn);
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
        model: modelToUse,
    };
}

/** The assistant message with its persisted metadata, before tokenisation info. */
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
        const memoryExtractor = require('../../agents/memory/extractor');
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
                try { onEvent('memory_extraction_failed', { error: err.message }); } catch (_) { /* ignore */ }
            });
    } catch (memErr) {
        log.error('[AgentRuntime] Memory extractor load failed:', memErr.message);
    }
}

/**
 * SERVER-SIDE PERSISTENCE FOR REDACTION — for both delete mode
 * (guardrailViolation) and redact mode (processedUserMessage changed), the
 * last user message is re-written right after the current event-loop tick
 * (was setTimeout(5000), which raced with the conversation save).
 */
function scheduleRedactionRewrite(turn) {
    const { guardrailViolation, processedUserMessage, userMessage, conversation, userAuth, _serializeConversationWrite } = turn;
    const needsServerPersistence = guardrailViolation || processedUserMessage !== userMessage;
    if (!needsServerPersistence) return;
    const redactedContent = processedUserMessage !== userMessage
        ? processedUserMessage  // Use redacted version (with [REDACTED: RuleName])
        : '[Message removed - policy violation]';  // Full replacement for delete mode

    setImmediate(async () => {
        try {
            // restore:false — same reason as the guardrail-violation
            // persistence path: this block writes the array back via
            // updateConversation, and restoring tokens here would silently
            // overwrite tokenized content with real values for the whole
            // conversation.
            const conv = await agentStore.getConversationById(conversation.id, userAuth.encryptionKey, { restore: false });
            if (!conv || !conv.messages) return;
            // Find the LAST user message (more robust than index-based lookup)
            let lastUserIdx = -1;
            for (let i = conv.messages.length - 1; i >= 0; i--) {
                if (conv.messages[i].role === 'user') {
                    lastUserIdx = i;
                    break;
                }
            }
            if (lastUserIdx < 0) {
                log.warn('[RegexGuard] No user message found for redaction');
                return;
            }
            const updatedMessages = conv.messages.map((m, idx) => {
                if (idx === lastUserIdx) {
                    return { ...m, content: redactedContent, isRedacted: true };
                }
                return m;
            });
            await _serializeConversationWrite(conversation.id, () => agentStore.updateConversation(conversation.id, updatedMessages, userAuth.encryptionKey, userAuth.userId));
            log.info(`[RegexGuard] Server-side persistence completed for conversation ${conversation.id}`);
        } catch (redactErr) {
            log.error('[RegexGuard] Server-side persistence failed:', redactErr.message);
        }
    });
}

module.exports = { finalizeStreamTurn };
