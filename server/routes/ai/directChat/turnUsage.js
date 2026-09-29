/**
 * Direct Chat — what the streamed turn cost, written to the monitoring store.
 *
 * Never fails the turn: the answer is already on the wire by the time this
 * runs, so a monitoring outage is a log line. Moved verbatim out of
 * streamTurn.js.
 */

const log = require('../../../telemetry/log');

async function logTurnUsage(turn) {
    const { streamUsage } = turn;
    try {
        const usageStore = require('../../../stores/usageStore');
        await usageStore.logUsage({
            user_id: turn.userId,
            agent_name: 'direct-chat',
            agent_type: 'chat',
            model: turn.modelId,
            prompt_tokens: streamUsage?.prompt_tokens || 0,
            completion_tokens: streamUsage?.completion_tokens || 0,
            total_tokens: streamUsage?.total_tokens || ((streamUsage?.prompt_tokens || 0) + (streamUsage?.completion_tokens || 0)),
            cached_tokens: streamUsage?.cached_tokens || 0,
            cache_creation_tokens: streamUsage?.cache_creation_tokens || 0,
            // These two were missing, so every direct-chat turn logged zero
            // reasoning tokens and no cache TTL. Cost was still right —
            // reasoning tokens are already inside completion_tokens — but
            // the monitoring dashboards showed reasoning as unused.
            reasoning_tokens: streamUsage?.reasoning_tokens || 0,
            cache_ttl: streamUsage?.cache_ttl || null,
            stop_reason: streamUsage?.stop_reason || null,
            source: 'direct_chat',
            duration_ms: Date.now() - turn.streamStartTime,
            organization_id: turn.userOrgId || null,
            conversation_id: turn.convId || null,
        });
    } catch (e) {
        log.warn('[DirectChat] Failed to log usage:', e.message);
    }
}

module.exports = { logTurnUsage };
