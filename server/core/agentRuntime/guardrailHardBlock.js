/**
 * Streaming agent chat — guardrail / moderation hard block.
 *
 * When input guardrails or moderation flagged the turn, the model must never
 * see the user message or any KB context: emit the structured block event,
 * persist an English fallback reply (the frontend overrides it with t()),
 * schedule the server-side redaction of the violating user message and end
 * the turn with a result object. Moved verbatim out of chatStream.js.
 */
const agentStore = require('../../stores/agentStore');
const log = require('../../telemetry/log');

async function respondGuardrailHardBlock({ moderationViolation, guardrailViolation, onEvent, messageMetadata, durableMessages, persistDurable, isEphemeral, conversation, userAuth, processedUserMessage, userMessage, modelToUse, _serializeConversationWrite }) {
        const violationType = moderationViolation || guardrailViolation;

        // Send structured event so frontend can compose the translated message
        onEvent('guardrail_blocked', { violation: violationType });

        // English fallback for DB persistence (not shown to user — frontend overrides with t())
        const persistedResponse = `Your message was flagged as **"${violationType}"**.\n\nThis message was blocked by our security policy and cannot be processed. Would you like to rephrase your question?`;

        // Persist the conversation with the English fallback response
        const assistantMsg = {
            role: 'assistant',
            content: persistedResponse,
            parentId: messageMetadata.parentId || null
        };
        durableMessages.push(assistantMsg);
        await persistDurable();

        // Server-side persistence: redact/remove the violating user message
        if (!isEphemeral) {
            setImmediate(async () => {
                try {
                    // restore:false — we're about to write the array back via
                    // updateConversation; the default would de-tokenize every
                    // message and persist real values, breaking the round-trip.
                    const conv = await agentStore.getConversationById(conversation.id, userAuth.encryptionKey, { restore: false });
                    if (conv && conv.messages) {
                        let lastUserIdx = -1;
                        for (let i = conv.messages.length - 1; i >= 0; i--) {
                            if (conv.messages[i].role === 'user') { lastUserIdx = i; break; }
                        }
                        if (lastUserIdx >= 0) {
                            const redactedContent = guardrailViolation
                                ? '[Message removed - policy violation]'
                                : (processedUserMessage !== userMessage ? processedUserMessage : '[Message removed - policy violation]');
                            const updatedMessages = conv.messages.map((m, idx) =>
                                idx === lastUserIdx ? { ...m, content: redactedContent, isRedacted: true } : m
                            );
                            await _serializeConversationWrite(conversation.id, () => agentStore.updateConversation(conversation.id, updatedMessages, userAuth.encryptionKey, userAuth.userId));
                            log.info(`[AgentRuntime] Guardrail: server-side redaction completed for conversation ${conversation.id}`);
                        }
                    }
                } catch (err) {
                    log.error('[AgentRuntime] Guardrail: server-side redaction failed:', err.message);
                }
            });
        }

        log.info(`[AgentRuntime] Guardrail hard-block — skipped AI entirely (violation: ${violationType})`);
        return {
            message: persistedResponse,
            toolCalls: [],
            conversationLength: durableMessages.length,
            conversationId: conversation.id,
            guardrailViolation: violationType,
            model: modelToUse
        };
}

module.exports = { respondGuardrailHardBlock };
