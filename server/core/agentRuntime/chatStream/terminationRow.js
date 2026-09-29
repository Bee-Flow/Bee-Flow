/**
 * The row every termination log of a streaming turn writes.
 *
 * `terminationStore.logTermination` is called from a dozen exits — aborted,
 * max_tokens, error, max_iterations — and each of them wants the same
 * identity/telemetry base with only the `termination_type` differing. This
 * file owns that base and the attachment telemetry on it (counts and bytes
 * only, never content: it exists to explain a large-input termination, e.g. a
 * big PDF that ate the output budget before a single useful token).
 *
 * Moved verbatim out of chatStream.js. The COUNTERS are passed in at call
 * time, not captured, because they keep moving while the turn runs.
 */
const testChatMod = require('../testChat');

function attachmentTelemetry({ messageMetadata }) {
    // Attachment metadata — counts + bytes only, helps explain large-input
    // terminations (e.g. user uploads a big PDF and the model runs out of
    // output tokens before producing anything useful).
    const _termAttachmentCount = Array.isArray(messageMetadata?.attachments) ? messageMetadata.attachments.length : 0;
    const _termAttachmentBytes = (() => {
        const list = messageMetadata?.attachments;
        if (!Array.isArray(list)) return 0;
        let total = 0;
        for (const att of list) {
            if (att?.size && Number.isFinite(att.size)) { total += att.size; continue; }
            if (typeof att?.content !== 'string') continue;
            if (att.content.startsWith('data:')) {
                const comma = att.content.indexOf(',');
                const b64 = comma >= 0 ? att.content.slice(comma + 1) : att.content;
                total += Math.floor(b64.length * 0.75);
            } else {
                total += Buffer.byteLength(att.content, 'utf8');
            }
        }
        return total;
    })();

    return { _termAttachmentCount, _termAttachmentBytes };
}

function terminationBase({
    userId, agent, agentId, modelToUse, messageMetadata, conversation,
    iterations, _chatStartTime, _termPromptTokens, _termCompletionTokens,
    _termAttachmentCount, _termAttachmentBytes,
}) {
    return {
        user_id: userId || null,
        organization_id: agent?.organization_id || messageMetadata?.userOrgId || null,
        agent_id: agentId || null,
        agent_name: agent?.name || null,
        model: modelToUse || null,
        source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
        conversation_id: conversation?.id || null,
        parent_call_id: messageMetadata?.parentCallId || null,
        iteration_count: iterations,
        duration_ms: Date.now() - _chatStartTime,
        prompt_tokens: _termPromptTokens,
        completion_tokens: _termCompletionTokens,
        total_tokens: _termPromptTokens + _termCompletionTokens,
        attachment_count: _termAttachmentCount,
        attachment_bytes: _termAttachmentBytes,
    };
}

module.exports = { attachmentTelemetry, terminationBase };
