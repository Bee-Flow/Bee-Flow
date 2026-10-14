/**
 * What the non-streaming agent loop (./chatWithAgent) settles before its first
 * round: the generation settings, the fixed tool params, and the input-side
 * privacy pass (Unicode smuggling, PII, the token-preservation addendum).
 */
const { getAIConfig } = require('../aiAgent');
const agentStore = require('../../stores/agentStore');
const { getEUAwareTiers, TIER_DEFAULTS, findTierKeyForModel } = require('../llm/modelResolver');
const { validateInputForPii } = require('../privacy/piiDetection');
const { resolveShieldFor } = require('../privacy/orgShield');
const dlpRunner = require('../dlp/dlpRunner');
const { buildTokenPreservationAddendum } = require('../dlp/tokenPreservationPrompt');
const log = require('../../telemetry/log');

/**
 * Resolve the generation settings (maxTokens / temperature / reasoning) for a
 * resolved model, mirroring how direct chat builds `chatOptions`.
 *
 * `tierKey` is the tier that actually produced the model (see
 * resolveAgentModelWithTier) and is authoritative when given. Without it the
 * model id is reverse-mapped, which is a guess: several tiers may share one
 * model, and then the ladder in findTierKeyForModel decides rather than
 * whatever order the tier map happens to be stored in.
 *
 * `temperature` is still passed but the adapter drops it for restricted /
 * adaptive-only models. Falls back to tier defaults when the model isn't
 * attached to any tier.
 */
async function resolveGenerationSettings(modelId, { userOrgId = null, userId = null, tierKey: explicitTierKey = null } = {}) {
    let tiers = {};
    try {
        tiers = await getEUAwareTiers({ userOrgId, userId }) || {};
    } catch (_) {
        tiers = {};
    }

    const tierKey = (explicitTierKey && tiers[explicitTierKey])
        ? explicitTierKey
        : findTierKeyForModel(tiers, modelId);
    const tierSettings = (tierKey && tiers[tierKey]) ? tiers[tierKey] : {};
    const tierDefaults = TIER_DEFAULTS[tierKey] || TIER_DEFAULTS.smart || TIER_DEFAULTS.fast || {};

    return {
        maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens || 4096,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        reasoningEffort: tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
        reasoningSummary: tierSettings.reasoningSummary !== undefined
            ? tierSettings.reasoningSummary
            : (tierDefaults.reasoningSummary || false),
        budgetTokens: tierSettings.budgetTokens || undefined,
    };
}

/** The agent's fixed tool params, keyed by tool name. */
async function loadToolParamsMap(agentId) {
    const toolParamsMap = {};
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    for (const tc of toolConfigs) {
        // Convert component ID to tool name format (replace hyphens with underscores)
        const toolName = tc.componentId.replace(/-/g, '_');
        toolParamsMap[toolName] = tc.params;
    }
    return toolParamsMap;
}

/**
 * The input-side privacy pass over `messages` (mutated in place): Unicode
 * smuggling first, then PII detection. Resolves to the shield (also used by
 * the tool gate) and the token map of a tokenised last message, if any.
 *
 * Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when the
 * Azure Content Safety backend was dropped; PII detection still runs here.
 */
async function shieldIncomingMessages({ messages, agent, userId, userAuth, conversation }) {
    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        log.warn(`[ChatWithAgent] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
    }

    // ── PII Detection ─────────────────────────────────────────────────
    const aiConfigForPii = await getAIConfig();
    let piiTokenMap = null;
    // Agents owned by a consumer account have `organization_id === null` — fall
    // back to that user's personal Privacy Shield so PII detection still runs
    // (agent-path twin of BFSF-290).
    const orgShield = await resolveShieldFor({ orgId: agent.organization_id, userId });
    // PII gate: the shield's master `enabled` flag is the only switch.
    // detectPii() in piiDetection.js routes between the in-process
    // Transformers.js detector and the optional GLiNER guard service.
    const orgPiiEnabled = !!orgShield?.enabled;
    if (aiConfigForPii?.piiDetectionEnabled || orgPiiEnabled) {
        try {
            const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, userAuth?.piiActionOverride || null, null, { vaultUserId: userAuth?.userId || null });

            if (piiResult && piiResult.tokenizedText) {
                // Redact/tokenize mode: replace last user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                if (conversation?.id) dlpRunner.mergeTokenMap(conversation.id, piiTokenMap);
                log.warn(`[ChatWithAgent] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);
            }
        } catch (piiError) {
            // Propagate both a PII block and a fail-closed "protection
            // unavailable" block to the route handler (BFSF-269).
            if (piiError.message?.includes('PII Detected') || piiError.privacyUnavailable) {
                throw piiError;
            }
            // Service unavailable → fail-open
        }
    }
    return { orgShield, piiTokenMap };
}

/** PII tokens: instruct the LLM to preserve & reuse them rather than invent new placeholders. */
function tokenPreservationAddendum(conversation, piiTokenMap) {
    const _convTokenMap = conversation?.id
        ? dlpRunner.getConversationTokenMap(conversation.id)
        : (piiTokenMap || {});
    return buildTokenPreservationAddendum(_convTokenMap);
}

module.exports = { resolveGenerationSettings, loadToolParamsMap, shieldIncomingMessages, tokenPreservationAddendum };
