/**
 * App Studio Builder — which model serves this turn.
 *
 * Every rule is measured against the tiers THIS person may use
 * (core/entitlements/tierAccess, taskType automation: the list the builder's
 * own dropdown offers). In this order: a CONTINUATION turn resumes the
 * interrupted build on the tier the token was minted on, while the person may
 * still use it; an explicit `modelTier` is honoured when it is theirs and
 * refused when it is not; and 'auto' ranks the person's configured tiers
 * (selectAutoBuilderTier) and then applies the capability floor within the
 * same tiers, because assembling a typed component tree on a small model
 * loops to the iteration cap.
 *
 * The tiers are resolved against the person's whole map (getUserTierMap),
 * custom tiers included. A built-in tier with no model falls back to the
 * workspace's global default, as a fresh install with no tiers configured
 * needs; a custom tier with no model is `model_unavailable`, because the
 * global default may be exactly the model that tier exists to avoid.
 *
 * Runs pre-SSE, so its refusals are clean JSON: `{ error, code, status? }`
 * is the route's body and status (400 when it names none), and a
 * store/provider failure throws for the caller's own catch. The adapter
 * itself is built by the route from the returned `cfg`.
 */

const { getUserTierMap } = require('../../../core/llm/modelResolver');
const { getProviderForModel, getAIConfig } = require('../../../core/aiAgent');
const { tierAccessFor, tierRefusal } = require('../../../core/entitlements/tierAccess');
const { selectAutoBuilderTier } = require('../../../appStudio/builderModelProfiles');
const { applyBuilderTierFloor } = require('../builderShared');
const log = require('../../../telemetry/log');

async function resolveBuilderModel({ userOrgForTiers, userId, session = null, continueToken, priorSnapshot, modelTier }) {
    let resolvedTier;
    let modelId;
    let tier = {};
    let cfg;
    // The map this person picks from: EU-aware base tiers plus the global and
    // org custom tiers -- the same one the builder's dropdown and the routine
    // builder read. It was the base tiers alone, so a custom tier the gate
    // allowed had no model here and ran on the global default below.
    const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
    const access = await tierAccessFor({ userId, session, taskType: 'automation' });
    // What 'auto', and the floor after it, may choose from: this person's
    // configured tiers. Ranking the whole map took the strongest model the
    // workspace had, whatever the person's groups allowed.
    const { candidates: autoTiers, refused: autoRefused } = access.autoChoice(tiers);
    // Continuation turns resume the interrupted build on the SAME tier —
    // reuse the persisted tier and SKIP auto re-resolution (+ capability
    // floor, already applied on the turn that minted the token). A tier the
    // person has lost since then is not resumed: the turn resolves anew.
    const reuseTier = (continueToken && priorSnapshot
        && priorSnapshot.continueToken === continueToken && priorSnapshot.lastTier
        && access.allows(priorSnapshot.lastTier))
        ? priorSnapshot.lastTier : null;
    const requested = modelTier || 'auto';
    if (reuseTier) {
        resolvedTier = reuseTier;
        log.info(`[AppStudioBuilder] Continuation: reusing tier "${resolvedTier}" (auto re-resolution skipped)`);
    } else if (!access.allows(requested) || (requested === 'auto' && autoRefused)) {
        log.info(`[AppStudioBuilder] Tier "${requested}" is not available to this user — refused`);
        return tierRefusal(requested);
    } else {
        resolvedTier = requested;
        if (resolvedTier === 'auto') {
            // Auto: pick the MOST CAPABLE of the person's configured
            // models (newest Claude generation on top —
            // selectAutoBuilderTier). Building an app is always a hard,
            // tool-heavy, multi-step task, so the chat prompt-classifier
            // (which routes short messages to a fast/small tier) is the
            // wrong instrument here. Ranks ONLY what admins configured —
            // never invents a model. An EXPLICIT modelTier from the caller
            // skips this branch entirely.
            const best = selectAutoBuilderTier(autoTiers);
            if (best) {
                resolvedTier = best.tier;
                log.info(`[AppStudioBuilder] Auto: most capable permitted model → tier="${best.tier}" (${best.modelId})`);
            } else {
                // Nothing configured — fall through to the fast tier /
                // global default model resolution below.
                resolvedTier = 'fast';
            }
        }
    }
    tier = tiers[resolvedTier] || {};
    modelId = tier.modelId;
    // A custom tier exists to pin ONE model (an on-prem one, a regional one),
    // so without it there is nothing to run on: the global default may be the
    // very model the tier was made to avoid.
    if (!modelId && resolvedTier.startsWith('custom:')) {
        return { error: `No model configured for tier ${resolvedTier}`, code: 'model_unavailable' };
    }
    if (!modelId) {
        const globalConfig = await getAIConfig();
        modelId = globalConfig?.model || null;
    }
    if (!modelId) {
        return { error: `No model configured for tier ${resolvedTier}`, code: 'model_unavailable' };
    }
    // Capability floor: assembling a typed component tree on a small model
    // loops to the iteration cap. Only applies when the user left 'auto';
    // an explicit tier choice is always honoured. It bumps within the
    // person's own tiers, never onto one their groups do not allow.
    // (Skipped for the local override AND continuation reuse.)
    if (!reuseTier && requested === 'auto') {
        const floored = applyBuilderTierFloor(resolvedTier, modelId, autoTiers);
        if (floored.modelId !== modelId) {
            log.info(`[AppStudioBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
            resolvedTier = floored.tier;
            modelId = floored.modelId;
            tier = tiers[resolvedTier] || tier;
        }
    }
    cfg = await getProviderForModel(modelId);
    return { resolvedTier, modelId, tier, cfg };
}

module.exports = { resolveBuilderModel };
