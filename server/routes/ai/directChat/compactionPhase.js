/**
 * Direct Chat — the lossy local compaction of a long conversation.
 *
 * Opt-in per org and off by default (core/llm/contextPolicy.js); with it off
 * the history is left exactly as stored and the provider's own server-side
 * context management does the trimming losslessly. Its own failure is never
 * the turn's: the catch falls back to the full history. Moved verbatim out of
 * streamTurn.js.
 */

const { withPhase } = require('../../../core/agentRuntime/phaseEvents');
const log = require('../../../telemetry/log');

async function compactConversation(turn) {
    const { send } = turn;
    // Summarize old messages to reduce token usage on long conversations.
    // The persisted summaryUpTo watermark makes this incremental: once a
    // prefix is folded, later turns rebuild the summary block locally (no
    // LLM call) until the unsummarized tail crosses the threshold again.
    // The user-visible "compacting" phase only fires on a real fold.
    try {
        const { compactMessages, needsSummarization } = require('../../../core/llm/compaction');
        const { resolveContextPolicy, buildCompactionOptions } = require('../../../core/llm/contextPolicy');
        const convMessageCount = turn.messages.filter(m => m.role !== 'system').length;
        const contextPolicy = await resolveContextPolicy(turn.userOrgForTiers);
        const compactionOpts = buildCompactionOptions({
            policy: contextPolicy,
            existingSummary: turn.conversationSummary,
            summaryUpTo: turn.conversationSummaryUpTo,
            modelId: turn.modelId,
            userOrgId: turn.userOrgForTiers,
        });
        const runCompaction = () => compactMessages(turn.messages, compactionOpts);
        const compactionResult = needsSummarization(turn.messages, compactionOpts)
            ? await withPhase(send, 'compacting', null, runCompaction)
            : await runCompaction();
        turn.messages = compactionResult.messages;
        turn.conversationSummary = compactionResult.newSummary;
        turn.conversationSummaryUpTo = compactionResult.summaryUpTo;
        if (compactionResult.didSummarize) {
            const compactedCount = turn.messages.filter(m => m.role !== 'system').length;
            send('token_savings', {
                type: 'compaction',
                messagesBefore: convMessageCount,
                messagesAfter: compactedCount,
            });
            log.info(`[DirectChat] 📦 Compaction: ${convMessageCount} → ${compactedCount} messages`);
        }
    } catch (err) {
        log.warn('[DirectChat] Compaction failed, using full history:', err.message);
    }
}

module.exports = { compactConversation };
