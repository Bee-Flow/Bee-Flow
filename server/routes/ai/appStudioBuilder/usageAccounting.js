/**
 * App Studio Builder — the ONE usage row a turn writes (Wave 6c).
 *
 * `ai_usage_log` has no metadata column, so the identifying fields fold into
 * real columns (agent_id=appId, conversation_id=session, stop_reason=outcome)
 * and the full per-turn metadata ships as a structured stdout line
 * ("[AppStudioBuilder] usage {...}") → OpenObserve.
 *
 * The logger is a closure over the turn's live state, not a snapshot: the
 * route's outer catch calls it too, so a turn that blew up mid-loop still
 * reports the rounds and tool calls it burned. It is idempotent — the first
 * caller wins, whichever path got there.
 */

const usageStore = require('../../../stores/usageStore');
const log = require('../../../telemetry/log');

function makeTurnUsageLogger({ userId, draftWrap, modelId, resolvedTier, usageTotals, turnStartedAt, turn }) {
    let usageLogged = false;
    return (outcome) => {
        if (usageLogged) return; // one row per turn, even if both paths fire
        usageLogged = true;
        const durationMs = Date.now() - turnStartedAt;
        const metadata = {
            appId: draftWrap.appId,
            sessionId: draftWrap.builderSessionId,
            tier: resolvedTier,
            iterations: turn.iter,
            toolCallCount: turn.toolCallCount,
            mutatingToolCalls: turn.mutatingToolCalls,
            validationErrorCount: turn.validationErrorCount,
            finalized: turn.lastFinalized,
            outcome,
            durationMs,
        };
    // ai_usage_log has no metadata column, so fold the identifying fields
    // into real columns (agent_id=appId, conversation_id=session,
    // stop_reason=outcome) and ship the full metadata as a structured stdout
    // line → OpenObserve. Fire-and-forget: usage logging must never break a
    // turn (logUsage can reject on a PAYG FX lookup — swallow it here).
    Promise.resolve(
        usageStore.logUsage({
            user_id: userId,
            organization_id: draftWrap.orgId || null,
            agent_id: draftWrap.appId || null,
            agent_name: `App builder: ${(draftWrap.def && draftWrap.def.meta && draftWrap.def.meta.name) || 'Untitled app'}`,
            agent_type: 'studio_app_builder',
            model: modelId,
            prompt_tokens: usageTotals.inputTokens,
            completion_tokens: usageTotals.outputTokens,
            total_tokens: usageTotals.inputTokens + usageTotals.outputTokens,
            duration_ms: durationMs,
            source: 'studio_app_builder',
            conversation_id: draftWrap.builderSessionId || draftWrap.appId || null,
            stop_reason: outcome,
        }),
    ).catch((e) => log.error('[AppStudioBuilder] usage log failed (non-fatal):', e.message));
    log.info(`[AppStudioBuilder] usage ${JSON.stringify(metadata)}`);
    };
}

module.exports = { makeTurnUsageLogger };
