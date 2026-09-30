// @typecheck
/**
 * Which model answers in a team chat: the depth the asking member picked
 * (the same tiers a normal chat's slider offers, depths only), resolved for
 * them the way a normal chat resolves it.
 */

'use strict';

const log = require('../telemetry/log');

const MODEL_TIER = 'fast';
/** The tiers a chat message can pick: depths of the same kind of answer, as in a normal chat's slider. */
const DEPTH_TIERS = Object.freeze(['fast', 'thinking', 'pro', 'deep_thinking']);

/**
 * The asking member's model for the team chat, or null when none is configured.
 *
 * @param {{ userId: string, orgId: string|null, modelTier?: string|null, message?: string }} p
 * @param {{ resolver?: any, getProviderForModel?: Function, getUserTierMap?: Function, classifyWithLLM?: Function }} [deps]
 */
async function resolveChatModel({ userId, orgId, modelTier = null, message = '' }, deps = {}) {
    const resolver = deps.resolver || require('../core/llm/modelResolver');
    const getProviderForModel = deps.getProviderForModel || ((id) => require('../core/aiAgent').getProviderForModel(id));
    const scope = { userOrgId: orgId || null, userId };
    let tierName = DEPTH_TIERS.includes(modelTier) ? modelTier : MODEL_TIER;
    if (modelTier === 'auto') {
        // The same classifier a normal chat uses, over the depth tiers only.
        try {
            const tiers = await (deps.getUserTierMap || resolver.getUserTierMap)(scope);
            const offered = Object.fromEntries(Object.entries(tiers || {}).filter(([k]) => DEPTH_TIERS.includes(k)));
            const classify = deps.classifyWithLLM || ((msg, offeredTiers, who) => require('../core/llm/promptClassifier').classifyWithLLM(msg, offeredTiers, who));
            const picked = await classify(message, offered, scope);
            if (picked && DEPTH_TIERS.includes(picked.tier)) tierName = picked.tier;
        } catch (err) {
            log.info(`[ProjectChat] auto tier failed, using ${MODEL_TIER}: ${err && err.message}`);
        }
    }
    let modelId = await resolver.resolveModelForTierName(tierName, scope);
    // A tier this member has no model for answers on the default one, as a normal chat does.
    if (!modelId && tierName !== MODEL_TIER) { tierName = MODEL_TIER; modelId = await resolver.resolveModelForTierName(tierName, scope); }
    if (!modelId) return null;
    let tier = {};
    try { tier = await resolver.getTierConfig(tierName, scope) || {}; } catch (_) { tier = {}; }
    let providerConfig = {};
    try {
        const p = await getProviderForModel(modelId);
        providerConfig = { providerType: p?.providerType, url: p?.url, displayName: p?.providerName || p?.providerType || 'LLM' };
    } catch (_) {
        // Unknown provider: the DLP classifier treats it as external, the safe side.
    }
    /** @type {{ maxTokens: number, temperature?: number }} */
    const options = { maxTokens: tier.maxTokens || 4096 };
    if (tier.temperature !== undefined) options.temperature = tier.temperature;
    return { modelId, options, providerConfig, tier: tierName, requestedTier: modelTier || MODEL_TIER };
}

module.exports = { MODEL_TIER, DEPTH_TIERS, resolveChatModel };
