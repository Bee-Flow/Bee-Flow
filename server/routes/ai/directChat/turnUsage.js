/**
 * Direct Chat — what the streamed turn cost, written to the monitoring store.
 *
 * Never fails the turn: the answer is already on the wire by the time this
 * runs, so a monitoring outage is a log line. Moved verbatim out of
 * streamTurn.js.
 */

const log = require('../../../telemetry/log');
const { usageLogFields } = require('../../../core/providers/usageNormalizer');

async function logTurnUsage(turn) {
    const { streamUsage } = turn;
    try {
        const usageStore = require('../../../stores/usageStore');
        await usageStore.logUsage({
            user_id: turn.userId,
            agent_name: 'direct-chat',
            agent_type: 'chat',
            model: turn.modelId,
            // Tokens, cache read/write (5m/1h split, cache_ttl), reasoning: the
            // adapter's normalised `done` payload (core/providers/usageNormalizer.js).
            ...usageLogFields(streamUsage),
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
