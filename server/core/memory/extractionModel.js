/**
 * Which model reads a finished exchange for memories, and how hard it works.
 *
 * ONE extractor runs after every chat reply (agents/memory/extractor.js; the
 * second one, core/memoryExtractor.js, was retired in the 2026-08 memory
 * overhaul — see agents/memory/singleExtractor.test.js). It used to inherit
 * the Fast tier with a 2,500-token output cap and up to 40,000 characters of
 * context. Against a hosted provider that is a rounding error. Against a
 * single-slot self-hosted server it is the SAME model the chat just used, so
 * every turn paid more full prompt evaluations (~150 tok/s prompt processing
 * on this box, measured 2026-09-11) queued in front of the user's next
 * message.
 *
 * This module is the single place that decides:
 *   - the model: the admin's dedicated `memory_extraction_model` when set
 *     (a 0.5-4B model is plenty for "list the facts in this exchange"), else
 *     the caller's agent model / Fast tier exactly as before;
 *   - the request shape: thinking OFF (a reasoning model would spend its
 *     whole budget deliberating over a JSON list), a 1k-token cap, and a
 *     stall timeout so a wedged background call cannot hold the slot;
 *   - how much of the exchange is read: the user's words carry the facts,
 *     the assistant's reply mostly repeats them.
 */

const configStore = require('../../stores/configStore');
const { resolveModelWithGlobalFallback } = require('../llm/modelResolver');

const CONFIG_KEY = 'memory_extraction_model';

/** Request options every extractor spreads first; callers add temperature. */
const EXTRACTION_CHAT_OPTIONS = Object.freeze({
    maxTokens: 1024,
    reasoningEffort: 'none',
    budgetTokens: 0,
    timeoutMs: 60_000,
});

/** Character budgets per side of the exchange (was 20,000 / 20,000). */
const EXTRACTION_MAX_CHARS = Object.freeze({ user: 8000, assistant: 4000 });

/**
 * @param {object} [opts]
 * @param {string|null} [opts.agentModel] the extractor agent's own model
 *   setting (may be `tier:…`), used only when no dedicated model is configured
 * @param {string|null} [opts.userOrgId] for EU-aware tier resolution
 * @param {string|null} [opts.userId]
 * @returns {Promise<string|null>} a concrete model id, or null when nothing
 *   at all is configured (the callers keep their own last-resort fallback)
 */
async function resolveMemoryExtractionModel({ agentModel = null, userOrgId = null, userId = null } = {}) {
    let configured = null;
    try {
        configured = await configStore.getConfig(CONFIG_KEY);
    } catch (_) {
        // A config-store hiccup must not stop extraction; fall through to the
        // tier path the extractors always had.
    }
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return resolveModelWithGlobalFallback(agentModel, { userOrgId, userId, fallbackTier: 'fast' });
}

module.exports = {
    resolveMemoryExtractionModel,
    EXTRACTION_CHAT_OPTIONS,
    EXTRACTION_MAX_CHARS,
    MEMORY_EXTRACTION_MODEL_KEY: CONFIG_KEY,
};
