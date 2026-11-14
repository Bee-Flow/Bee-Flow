// @typecheck strict
/**
 * CMS builder: which tier and model a turn runs on. An explicit tier the user
 * may pick is honoured; anything else is classified, lands on `fast` when the
 * classifier fails, and is lifted off a small model (assembling structured
 * blocks on one loops to the round cap). The builder should always run, so a
 * tier that is not permitted is never an error.
 *
 * The collaborators come from the route (routes/ai/cmsBuilder.js).
 */

'use strict';

const log = require('../../../telemetry/log');
const { applyBuilderTierFloor } = require('../builderShared');

/**
 * @typedef {import('../../../core/entitlements/userTiers').GetPermittedTierKeysArgs['session']} Session
 * @typedef {{ modelId?: string, reasoningSummary?: string | null, [setting: string]: unknown }} Tier
 * @typedef {Record<string, Tier>} TierMap
 * @typedef {{
 *   getUserTierMap: (who: { userOrgId: string | null, userId: string }) => Promise<TierMap>,
 *   getPermittedTierKeys: (who: { userId: string, session: Session }) => Promise<Set<string>>,
 *   classify: (message: string, tiers: TierMap, who: { userOrgId: string | null, userId: string }) => Promise<{ tier: string, method?: string, reason?: string }>,
 *   getAIConfig: () => Promise<{ model?: string | null } | null | undefined>,
 * }} ModelSelectionDeps
 * @typedef {{ modelTier: unknown, message: unknown, userId: string, userOrgId: string | null, session: Session }} ModelRequest
 */

/**
 * The tier the client asked for when the user may select it, else 'auto'.
 * @param {string} requested
 * @param {TierMap} tiers
 * @param {ModelRequest} request
 * @param {ModelSelectionDeps} deps
 */
async function explicitTierOrAuto(requested, tiers, request, deps) {
    if (requested === 'auto') return 'auto';
    try {
        const permitted = await deps.getPermittedTierKeys({ userId: request.userId, session: request.session });
        if (permitted.has(requested) && tiers[requested]) return requested;
        log.info(`[CmsBuilder] Tier "${requested}" not permitted/configured for user — falling back to auto`);
    } catch (err) {
        log.info(`[CmsBuilder] Tier permission check failed (${/** @type {Error} */ (err).message}) — falling back to auto`);
    }
    return 'auto';
}

/**
 * The classifier's tier for the message; `fast` when it fails.
 * @param {TierMap} tiers
 * @param {ModelRequest} request
 * @param {ModelSelectionDeps} deps
 */
async function classifiedTier(tiers, request, deps) {
    try {
        const classifyTiers = Object.fromEntries(
            Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm'),
        );
        const result = await deps.classify(String(request.message), classifyTiers, { userOrgId: request.userOrgId, userId: request.userId });
        log.info(`[CmsBuilder] Auto: tier="${result.tier}" (${result.method}: ${result.reason})`);
        return result.tier;
    } catch (err) {
        log.info(`[CmsBuilder] Auto classification failed: ${/** @type {Error} */ (err).message}, using fast`);
        return 'fast';
    }
}

/**
 * The tier and model of the turn, or `refusal` when no model is configured.
 * @param {ModelRequest} request
 * @param {ModelSelectionDeps} deps
 * @returns {Promise<{ resolvedTier: string, modelId: string, tier: Tier } | { refusal: string }>}
 */
async function selectTurnModel(request, deps) {
    const tiers = await deps.getUserTierMap({ userOrgId: request.userOrgId, userId: request.userId });
    const requested = (typeof request.modelTier === 'string' && request.modelTier) ? request.modelTier : 'auto';
    let resolvedTier = await explicitTierOrAuto(requested, tiers, request, deps);
    const explicitPick = resolvedTier !== 'auto';
    if (!explicitPick) resolvedTier = await classifiedTier(tiers, request, deps);

    const tier = tiers[resolvedTier] || {};
    const modelId = tier.modelId || (await deps.getAIConfig())?.model;
    if (!modelId) return { refusal: `No model configured for tier ${resolvedTier}` };

    // The capability floor applies only to a tier that came from 'auto'; an explicit choice is always honoured.
    const floored = explicitPick ? null : applyBuilderTierFloor(resolvedTier, modelId, tiers);
    if (floored && floored.modelId !== modelId) {
        log.info(`[CmsBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
        return { resolvedTier: floored.tier, modelId: floored.modelId, tier: tiers[floored.tier] || tier };
    }
    return { resolvedTier, modelId, tier };
}

module.exports = { selectTurnModel };
