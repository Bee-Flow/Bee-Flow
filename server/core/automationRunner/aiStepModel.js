/**
 * TEMPORARY override for the model a routine's `ai_step` runs on.
 *
 * Config key `ai_step_model` (admin UI: Chat model tiers → "AI step model";
 * route /api/ai/config/ai-step-model). When set, every ai_step that asked for
 * the DEFAULT tier — `auto` or `fast`, which is what the builder writes — runs
 * on that one model instead of the tier's. Steps that explicitly picked a
 * heavier tier (thinking, pro, writer, a custom tier) are untouched: the
 * author asked for that model on purpose.
 *
 * Why (owner, 2026-09-11): on the single-slot local box the Fast tier IS the
 * 35B the builder itself runs on. A dry run with three ai_steps therefore
 * evicted the builder's prompt cache and queued three full prompt evaluations
 * in front of the next builder round. Pointing ai_steps at the 1.2B extract
 * model keeps the demo build warm. Unset = exactly the old behaviour.
 *
 * Pure decision in `aiStepOverrideFor`; the async wrapper only adds the
 * config read (60 s cache, failure → no override).
 */
const configStore = require('../../stores/configStore');

const AI_STEP_MODEL_KEY = 'ai_step_model';

/** Tiers the override replaces — the ones a step gets without asking. */
const DEFAULT_TIERS = Object.freeze(new Set(['auto', 'fast']));

/**
 * @param {{ configured: unknown, requestedTier: string|null|undefined }} p
 * @returns {string|null} the model id to run on, or null to keep the tier's
 */
function aiStepOverrideFor({ configured, requestedTier }) {
    if (typeof configured !== 'string' || !configured.trim()) return null;
    const tier = typeof requestedTier === 'string' && requestedTier.trim() ? requestedTier.trim() : 'auto';
    return DEFAULT_TIERS.has(tier) ? configured.trim() : null;
}

async function resolveAiStepModelOverride({ requestedTier } = {}) {
    let configured = null;
    try {
        configured = await configStore.getConfig(AI_STEP_MODEL_KEY);
    } catch (_) {
        // A config-store hiccup must never fail a routine step: no override.
    }
    return aiStepOverrideFor({ configured, requestedTier });
}

module.exports = { resolveAiStepModelOverride, aiStepOverrideFor, AI_STEP_MODEL_KEY, DEFAULT_TIERS };
