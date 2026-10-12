/**
 * Model resolution — resolves tier-based model configs to actual model IDs
 */
const { resolveModelId } = require('../aiAgent');
const configStore = require('../../stores/configStore');
const { getPermittedTierKeys } = require('../entitlements/userTiers');
const log = require('../../telemetry/log');

/**
 * Same resolution as resolveAgentModel, but also reports WHICH tier produced
 * the model.
 *
 * The tier is known here for free — it is either the one the agent declared or
 * the one the classifier picked — and it is the only place that knows it. Drop
 * it and the caller has to reverse-map the model id back to a tier, which is
 * ambiguous the moment two tiers share a model (the normal case on a
 * self-hosted box with one good model): storage order then decides, and an
 * agent silently runs on Deep Thinking's ceiling and effort. See
 * llm/modelResolver.findTierKeyForModel.
 *
 * `tierKey` is null when no tier produced the model — an unconfigured tier
 * falling through to the global default. Callers should treat that as "no tier
 * settings", not as a tier named null.
 *
 * @returns {Promise<{modelId: string, tierKey: string|null}>}
 */
async function resolveAgentModelWithTier(agentModel, userMessage, globalConfig, userContext = null) {
    // Not a tier-based model — force tier:auto resolution
    if (!agentModel || !agentModel.startsWith('tier:')) {
        log.info(`[AgentRuntime] Model "${agentModel || 'none'}" is not tier-based, resolving as tier:auto`);
        // Recurse with tier:auto to use the tier system
        return resolveAgentModelWithTier('tier:auto', userMessage, globalConfig, userContext);
    }

    const tierName = agentModel.substring(5); // strip 'tier:'
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU mode override: check agent's org first, then fall back to user's org
    const orgId = globalConfig?.organizationId || globalConfig?.userOrgId;
    if (orgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${orgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            const mergedTiers = { ...tiers };
            for (const [tn, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) {
                    mergedTiers[tn] = { ...mergedTiers[tn], ...euTier };
                }
            }
            tiers = mergedTiers;
            log.info(`[AgentRuntime] EU mode active for org ${orgId}`);
        }
    }

    // Fixed tier (fast/thinking/pro) — just look up the model
    if (tierName !== 'auto') {
        const tier = tiers[tierName];
        if (tier?.modelId) {
            log.info(`[AgentRuntime] Tier "${tierName}" → model: ${tier.modelId}`);
            return { modelId: tier.modelId, tierKey: tierName };
        }
        // Tier not configured, fall back to default
        log.info(`[AgentRuntime] Tier "${tierName}" not configured, using default`);
        return { modelId: resolveModelId(globalConfig.model), tierKey: null };
    }

    // Auto tier — restrict the classifier to tiers the user is permitted to use,
    // so it can't pick a premium tier (e.g. Flow/standard) the user lacks access to.
    let classifierTiers = tiers;
    if (userContext?.userId) {
        try {
            const permitted = await getPermittedTierKeys({
                userId: userContext.userId,
                session: userContext.session,
            });
            const filtered = {};
            for (const [key, value] of Object.entries(tiers)) {
                if (permitted.has(key)) filtered[key] = value;
            }
            // Always keep `fast` available as the safety-net fallback below.
            if (!filtered.fast && tiers.fast) filtered.fast = tiers.fast;
            classifierTiers = filtered;
        } catch (err) {
            log.info(`[AgentRuntime] Could not load permitted tiers for user ${userContext.userId}: ${err.message}`);
        }
    }

    try {
        const { classifyWithLLM } = require('../llm/promptClassifier');
        // The ids let the classifier see the Privacy Shield: with one on, the
        // raw message does not go to an external classifier model.
        const result = await classifyWithLLM(userMessage, classifierTiers, { userOrgId: orgId || null, userId: userContext?.userId || null });
        // Which tier actually supplied the model — the classifier's pick only
        // when that tier is configured, otherwise the `fast` safety net. The
        // caller uses this for the generation settings, so it has to name the
        // tier the model really came from, not the one we asked for.
        const picked = classifierTiers[result.tier]?.modelId ? result.tier
            : (classifierTiers.fast?.modelId || tiers.fast?.modelId) ? 'fast'
                : null;
        const model = classifierTiers[result.tier]?.modelId || classifierTiers.fast?.modelId || tiers.fast?.modelId || resolveModelId(globalConfig.model);
        log.info(`[AgentRuntime] Auto: tier="${result.tier}" → model: ${model} (${result.method}: ${result.reason})`);
        return { modelId: model, tierKey: picked };
    } catch (err) {
        log.info(`[AgentRuntime] Auto classification failed: ${err.message}, using default`);
        const fallback = classifierTiers.fast?.modelId || tiers.fast?.modelId;
        return fallback
            ? { modelId: fallback, tierKey: 'fast' }
            : { modelId: resolveModelId(globalConfig.model), tierKey: null };
    }
}

/**
 * The model id only. Kept as the entry point for every caller that does not
 * need the tier (KB summaries, support classifier, …) and for the test doubles
 * that stub this module with a plain string.
 */
async function resolveAgentModel(agentModel, userMessage, globalConfig, userContext = null) {
    const { modelId } = await resolveAgentModelWithTier(agentModel, userMessage, globalConfig, userContext);
    return modelId;
}

module.exports = { resolveAgentModel, resolveAgentModelWithTier };
