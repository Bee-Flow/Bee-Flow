/**
 * Which model an automation's `data_extraction` step runs on, and with what
 * request options.
 *
 * Config key `data_extraction_model` (admin UI: Chat model tiers → "Data
 * extraction model"; route /api/ai/config/data-extraction-model). Extraction
 * is not a chat: it wants one small, fast, deterministic model regardless of
 * the tier the automation author picked, thinking off, and a schema it cannot
 * wander from. So the step never reads a tier's options — only its model id,
 * and only as a fallback:
 *
 *   1. the config key, when an admin set one;
 *   2. the `fast` tier's modelId (EU-aware, per user/org like every ai_step);
 *   3. the global default model (`getAIConfig().model`).
 *
 * The request options are FIXED (`extractionRequestOptions`): temperature 0,
 * no reasoning, an output ceiling that grows with the field count and stops
 * at 4096, a two-minute timeout. Nothing here comes from a tier.
 *
 * This is deliberately separate from `aiStepModel.js`: that key is the
 * owner's temporary lever for ai_steps on the default tier and is being kept
 * exactly as it is. Pure decision in `dataExtractionModelFor`; the async
 * wrapper only adds the three reads, each of which may fail without failing
 * the step (a config-store hiccup must never fail an automation run — the next
 * fallback in the chain answers instead).
 */
const configStore = require('../../stores/configStore');

const DATA_EXTRACTION_MODEL_KEY = 'data_extraction_model';

/** Fixed request options — never a tier's. */
const EXTRACTION_TEMPERATURE = 0;
const EXTRACTION_REASONING_EFFORT = 'none';
const EXTRACTION_TIMEOUT_MS = 120_000;
const EXTRACTION_MAX_TOKENS_CAP = 4096;
const EXTRACTION_MAX_TOKENS_BASE = 512;
const EXTRACTION_MAX_TOKENS_PER_FIELD = 96;

/**
 * The output budget for `fieldCount` declared fields: a fixed floor for the
 * braces and quoting, plus room per field for a key and a short value, capped
 * so a 30-field step can never ask for more than the smallest model answers.
 *
 * @param {number} fieldCount
 * @returns {{ temperature: number, reasoningEffort: string, maxTokens: number, timeoutMs: number }}
 */
function extractionRequestOptions(fieldCount) {
    const n = Number.isFinite(Number(fieldCount)) && Number(fieldCount) > 0 ? Math.floor(Number(fieldCount)) : 0;
    return {
        temperature: EXTRACTION_TEMPERATURE,
        reasoningEffort: EXTRACTION_REASONING_EFFORT,
        maxTokens: Math.min(EXTRACTION_MAX_TOKENS_CAP, EXTRACTION_MAX_TOKENS_BASE + EXTRACTION_MAX_TOKENS_PER_FIELD * n),
        timeoutMs: EXTRACTION_TIMEOUT_MS,
    };
}

const nonBlank = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The pure decision: first non-blank string in the chain wins.
 *
 * @param {{ configured: unknown, fastTierModelId: unknown, globalModelId: unknown }} p
 * @returns {{ modelId: string|null, source: 'config'|'fast_tier'|'global'|null }}
 */
function dataExtractionModelFor({ configured, fastTierModelId, globalModelId }) {
    const fromConfig = nonBlank(configured);
    if (fromConfig) return { modelId: fromConfig, source: 'config' };
    const fromFast = nonBlank(fastTierModelId);
    if (fromFast) return { modelId: fromFast, source: 'fast_tier' };
    const fromGlobal = nonBlank(globalModelId);
    if (fromGlobal) return { modelId: fromGlobal, source: 'global' };
    return { modelId: null, source: null };
}

/**
 * Resolve the model for a data_extraction step. Each read is guarded on its
 * own so one failing source hands over to the next rather than failing the
 * step; only when all three are empty does `modelId` come back null, and the
 * executor turns that into a readable refusal.
 *
 * @param {{ userOrgId?: string|null, userId?: string|null }} [p]
 */
async function resolveDataExtractionModel({ userOrgId = null, userId = null } = {}) {
    let configured = null;
    try {
        configured = await configStore.getConfig(DATA_EXTRACTION_MODEL_KEY);
    } catch (_) {
        // A config-store hiccup must never fail an automation step: next fallback.
    }
    // The config key decides on its own; the tier map and the global config
    // are only read when it is empty, so a configured extraction model never
    // costs a tier lookup.
    if (nonBlank(configured)) return dataExtractionModelFor({ configured, fastTierModelId: null, globalModelId: null });

    let fastTierModelId = null;
    try {
        const { getUserTierMap } = require('../llm/modelResolver');
        const tiers = await getUserTierMap({ userOrgId, userId });
        fastTierModelId = tiers && tiers.fast ? tiers.fast.modelId : null;
    } catch (_) {
        // Same stance: fall through to the global default.
    }
    if (nonBlank(fastTierModelId)) return dataExtractionModelFor({ configured: null, fastTierModelId, globalModelId: null });

    let globalModelId = null;
    try {
        const globalConfig = await require('../aiAgent').getAIConfig();
        globalModelId = globalConfig ? globalConfig.model : null;
    } catch (_) {
        // Nothing left to fall back to; the caller reports it.
    }
    return dataExtractionModelFor({ configured: null, fastTierModelId: null, globalModelId });
}

module.exports = {
    DATA_EXTRACTION_MODEL_KEY,
    EXTRACTION_TEMPERATURE, EXTRACTION_REASONING_EFFORT, EXTRACTION_TIMEOUT_MS,
    EXTRACTION_MAX_TOKENS_CAP, EXTRACTION_MAX_TOKENS_BASE, EXTRACTION_MAX_TOKENS_PER_FIELD,
    extractionRequestOptions, dataExtractionModelFor, resolveDataExtractionModel,
};
