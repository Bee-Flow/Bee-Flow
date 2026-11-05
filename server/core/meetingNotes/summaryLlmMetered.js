// @typecheck strict
/**
 * The model side of the meeting-notes LLM steps (summaryLlm.js): which model a
 * step runs on (EU-aware tier resolution) and the metered call that writes one
 * usage-ledger row per model call. summaryLlm re-exports the resolvers.
 */

const llmClient = require('../llm/llmClient');
const { logSurfaceUsage } = require('../llm/surfaceUsage');

/** @typedef {import('../../utils/messageUtils').WireMessage} WireMessage */

/** @typedef {{ source: string, orgId?: string | null, userId?: string | null }} MeetingUsageMeta */

/**
 * Resolve the model for the summary / action-item steps.
 *
 * Asks for `thinking`, not `smart`. `smart` is a legacy alias that is never
 * written into `chat_model_tiers` (the config write path emits only
 * fast|standard|swarm|thinking|writer|pro), so modelResolver fell through its
 * `tiers[name] || tiers[fallbackTier]` chain to the FAST tier — meaning meeting
 * summaries and action items were silently produced by the fast model.
 * A hand-written `smart` key still wins, for anyone who set one deliberately.
 * @param {string | null} [userOrgId]
 */
async function resolveSmartModel(userOrgId = null) {
    try {
        const { resolveModelForTierName, getEUAwareTiers } = require('../llm/modelResolver');
        // Must inspect the map rather than just ask for 'smart':
        // resolveModelForTierName hardcodes fallbackTier:'fast', so requesting a
        // tier that isn't configured returns the fast model — truthy, and
        // therefore silently wrong. That is the bug this function had.
        const tiers = /** @type {Record<string, { modelId?: string } | undefined> | null} */ (await getEUAwareTiers({ userOrgId }));
        // Both candidate tiers must be checked here: asking resolveModelForTierName
        // for a tier that isn't configured falls through its hardcoded
        // fallbackTier:'fast' — truthy, and therefore silently wrong again, one
        // tier over from the original bug.
        const tierName = tiers?.smart?.modelId ? 'smart' : (tiers?.thinking?.modelId ? 'thinking' : null);
        if (!tierName) return 'gemini-2.0-flash';
        return await resolveModelForTierName(tierName, { userOrgId, fallback: 'gemini-2.0-flash' });
    } catch (_) {
        return 'gemini-2.0-flash';
    }
}

/**
 * Resolve the fast-tier model (title generation).
 * @param {string | null} [userOrgId]
 */
async function resolveFastModel(userOrgId = null) {
    try {
        const { resolveModelForTierName } = require('../llm/modelResolver');
        return await resolveModelForTierName('fast', { userOrgId, fallback: 'gemini-2.0-flash-lite' });
    } catch (_) {
        return 'gemini-2.0-flash-lite';
    }
}

/**
 * The usage meta of one step: its source, the organisation and, when the
 * caller named one, the meeting's owner.
 * @param {string} source
 * @param {string | null | undefined} orgId
 * @param {{ userId?: string | null } | null | undefined} opts
 * @returns {MeetingUsageMeta}
 */
function meetingMeta(source, orgId, opts) {
    return { source, orgId: orgId ?? null, userId: opts?.userId ?? null };
}

/**
 * llmClient.chat with one ledger row for the call (core/llm/surfaceUsage.js):
 * the meeting's owner when the caller names them, the organisation, the
 * source (`meeting_summary` or `meeting_actions`), the model and the tokens.
 * @param {MeetingUsageMeta} meta
 * @param {string} modelId
 * @param {WireMessage[]} messages
 * @param {Record<string, unknown>} options
 */
async function meteredChat(meta, modelId, messages, options) {
    const startedAt = Date.now();
    const result = await llmClient.chat(modelId, messages, options);
    logSurfaceUsage({ source: meta.source, userId: meta.userId, orgId: meta.orgId, model: modelId, usage: result?.usage, startedAt });
    return result;
}

module.exports = { resolveSmartModel, resolveFastModel, meetingMeta, meteredChat };
