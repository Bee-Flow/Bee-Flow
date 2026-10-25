/** @typedef {import('./turnSetup').BuilderTurn} BuilderTurn */
// @typecheck
/**
 * Automation Builder — which model a turn runs on: the `auto` classification
 * within this person's tiers, the builder's capability floor, the provider
 * and adapter, the narration model, the capability profile and the thinking
 * model flowlet sub-agents use. Moved verbatim from ./chatStream.js.
 *
 * Not core/llm/resolveTurnTier: the builder's `auto` keeps the classifier's
 * answer only when it is one of this person's tiers and falls back to the
 * cheapest of them (not `fast`), and the floor below runs after it.
 */

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const { getProviderForModel, getAIConfig } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const { cheapestTier } = require('../../../core/entitlements/tierAccess');
const { getProfileForModel } = require('../../../core/automationModel/builderModelProfiles');
const { applyBuilderTierFloor } = require('../builderShared');

/**
 * Resolve the turn's model. False when the turn ended (no model configured).
 * @param {BuilderTurn} turn
 */
async function resolveTurnModel(turn) {
    const { res, send, userId, message, modelTier, userOrgForTiers, tiers, requestedTier, permittedTiers, autoTiers, draftWrap } = turn;
    // Resolve model — mirrors the direct-chat flow (server/routes/ai/directChat.js)
    // so the builder honours the same tier dropdown, EU overrides, custom
    // tiers, and 'auto' classification the user sees in direct chat —
    // within the tiers this person may use (read above).

    // The tiers the builder AI may put on an ai_step's `modelTier`:
    // exactly what this user's dropdown offers (plus 'auto'), never
    // 'swarm' (chat-only). applyAddAi/applyUpdateStep validate against
    // this set so the model can't pick a tier the user doesn't have.
    draftWrap._allowedModelTiers = new Set(['auto', ...Object.keys(permittedTiers).filter(k => k !== 'swarm' && k !== 'standard')]);

    let resolvedTier = requestedTier;
    if (resolvedTier === 'auto') {
        // The classifier's own fallbacks answer `fast` whether or not that
        // tier is in the map it was handed, so its answer is kept only when
        // it is one of this person's; otherwise the cheapest that is.
        const cheapestOwn = cheapestTier(Object.keys(autoTiers)) || 'fast';
        try {
            const { classifyWithLLM } = require('../../../core/llm/promptClassifier');
            // Same exclusions direct chat applies (custom tiers and swarm
            // require explicit user choice and never win auto), over the
            // person's own configured tiers only.
            const result = await classifyWithLLM(message || '', autoTiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = autoTiers[result.tier] ? result.tier : cheapestOwn;
            log.info(`[AutomationBuilder] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}${resolvedTier === result.tier ? '' : `; "${result.tier}" is not this user's`})`);
        } catch (err) {
            log.info(`[AutomationBuilder] Auto classification failed: ${/** @type {Error} */ (err).message}, using ${cheapestOwn}`);
            resolvedTier = cheapestOwn;
        }
    }

    let modelId;
    let cfg;
    let tier = {};
    {
        tier = tiers[resolvedTier] || {};
        modelId = tier.modelId;
        if (!modelId) {
            const globalConfig = await getAIConfig();
            modelId = globalConfig?.model || null;
        }
        if (!modelId) {
            send('error', { error: `No model configured for tier ${resolvedTier}` });
            res.end(); return false;
        }

        // Capability floor: assembling a typed DAG is far harder than chat, so
        // when the user left the builder on 'auto' we must not run on a
        // small/fast model — those emit malformed bindings and loop to the
        // iteration cap. Bump up to the first non-small tier. An explicit user
        // tier choice is always honoured. See builderModelProfiles.js.
        // It bumps within the person's own tiers, never onto one their
        // groups do not allow.
        // (Skipped for the local override: that model is small by design.)
        if (modelTier === 'auto' || !modelTier) {
            const floored = applyBuilderTierFloor(resolvedTier, modelId, autoTiers);
            if (floored.modelId !== modelId) {
                log.info(`[AutomationBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
                resolvedTier = floored.tier;
                modelId = floored.modelId;
                // The tier object drives reasoningEffort / reasoningSummary
                // below — re-point it at the tier we actually run on, or
                // the floored model inherits the small tier's settings.
                tier = tiers[resolvedTier] || tier;
            }
        }

        cfg = await getProviderForModel(modelId);
    }
    const adapter = getAdapter(cfg.providerType, cfg.url);

    // Mirror direct chat: only emit model_selected when the *user* picked
    // 'auto', so the message bubble can render "Auto → <real tier>".
    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }

    // Narrated thinking line: a small side model turns the reasoning
    // stream into one present-tense phrase for the canvas (see
    // thoughtNarrator.js). Off unless an admin set the key; read once per
    // turn like the tier config so a config change never lands mid-build,
    // and never fatal — the client has its own fallbacks.
    let narrationModelId = '';
    try {
        const raw = await configStore.getConfig('builder_narration_model');
        narrationModelId = typeof raw === 'string' ? raw.trim() : '';
    } catch (_) { narrationModelId = ''; }

    // Pick the capability profile for this model. Drives prompt
    // variant, tool surface, temperature, iteration budget,
    // first-turn toolChoice enforcement, catalogue filtering, and
    // few-shot count. See server/automation/builderModelProfiles.js.
    // Optional admin override map `builder_model_profiles`
    // ({ "<modelId>": "<band>" }) for models the regex classifier gets
    // wrong; an unknown band is ignored (see getProfileForModel).
    let profileOverrides = null;
    try {
        const raw = await configStore.getConfig('builder_model_profiles');
        profileOverrides = raw && typeof raw === 'object' ? raw
            : (typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : null);
    } catch (_) { profileOverrides = null; }
    const profile = getProfileForModel(modelId, profileOverrides);
    log.info(`[AutomationBuilder] model=${modelId} profile=${JSON.stringify(profile)}`);
    // Result-echo detail: lean (small-model) profiles keep the full
    // structured `_draftSteps` echo on every mutation — they rely on it —
    // while capable models get the compact id line (see applyToolCall).
    draftWrap._resultDetail = profile.promptVariant === 'lean' ? 'full' : 'compact';

    // Flowlet sub-agents (builder_generate_layer[s]) run on the THINKING
    // tier regardless of which model is driving the main chat — building
    // a whole sub-flow benefits from reasoning — when this person may use
    // it. Otherwise, as flowletAgent.resolveLayerAgentModel orders it,
    // fast, then the chat model itself; all from the person's own tiers,
    // where resolveLayerAgentModel read the whole map.
    const thinkingModelId = permittedTiers.thinking?.modelId || permittedTiers.fast?.modelId || modelId;

    Object.assign(turn, { modelId, cfg, tier, adapter, narrationModelId, profile, thinkingModelId });
    return true;
}

module.exports = { resolveTurnModel };
