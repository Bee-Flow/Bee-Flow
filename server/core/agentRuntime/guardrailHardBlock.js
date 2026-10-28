// @typecheck strict
/**
 * Streaming agent chat — guardrail / moderation hard block.
 *
 * When input guardrails or moderation flagged the turn, the model must never
 * see the user message or any KB context: emit the structured block event,
 * persist an English fallback reply (the frontend overrides it with t()),
 * schedule the server-side redaction of the violating user message and end
 * the turn with a result object. Moved verbatim out of chatStream.js.
 */
const log = require('../../telemetry/log');
const { redactTurnUserMessage } = require('./finalizeTurn');

/** @param {{ moderationViolation: string | null, guardrailViolation: string | null, onEvent: import('./chatStream/turnState').OnEvent, messageMetadata: import('./chatStream/turnState').MessageMetadata, durableMessages: import('./chatStream/turnState').ChatMessage[], userSave: import('./chatStream/turnState').ChatMessage | null, persistDurable: () => Promise<void>, isEphemeral: boolean, conversation: import('./chatStream/turnState').ConversationRow, processedUserMessage: string, userMessage: string, modelToUse: string }} opts */
async function respondGuardrailHardBlock({ moderationViolation, guardrailViolation, onEvent, messageMetadata, durableMessages, userSave, persistDurable, isEphemeral, conversation, processedUserMessage, userMessage, modelToUse }) {
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

        // Server-side persistence: redact/remove the violating user message.
        // This turn's own user row, saved again with the turn (see
        // ./finalizeTurn.js redactTurnUserMessage), never "the last user
        // message" of a re-read conversation, which may be another turn's.
        if (!isEphemeral) {
            const redactedContent = guardrailViolation
                ? '[Message removed - policy violation]'
                : (processedUserMessage !== userMessage ? processedUserMessage : '[Message removed - policy violation]');
            setImmediate(() => redactTurnUserMessage({
                userSave, persistDurable, redactedContent, conversationId: conversation.id, tag: '[AgentRuntime] Guardrail:',
            }));
        }

        log.info(`[AgentRuntime] Guardrail hard-block — skipped AI entirely (violation: ${violationType})`);
        return {
            message: persistedResponse,
            toolCalls: /** @type {Record<string, unknown>[]} */ ([]),
            conversationLength: durableMessages.length,
            conversationId: conversation.id,
            guardrailViolation: violationType,
            model: modelToUse
        };
}

module.exports = { respondGuardrailHardBlock };
