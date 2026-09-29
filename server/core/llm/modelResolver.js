// @typecheck
/**
 * Model Resolver — Single source of truth for tier-based model resolution.
 *
 * Replaces the duplicated tier:fast / tier:smart → actual-model-id logic
 * that was scattered across chatTitle.js, extractor.js, system.js routes,
 * and aiAgent.js.
 *
 * Usage:
 *   const { resolveModelForTier } = require('./modelResolver');
 *   const model = await resolveModelForTier(agent.model, { userOrgId, fallbackTier: 'fast' });
 */

const configStore = require('../../stores/configStore');
const { createTtlCache } = require('../../utils/ttlCache');

// ─── Tier Defaults ────────────────────────────────────────────────────────────
// Centralised token / temperature / reasoning standards per tier.
// User-configured values (from the admin UI) override these; these are the
// fallback defaults when a tier setting is not explicitly configured.
//
// Rationale:
//   - fast:          Short, snappy answers. Low token ceiling = faster completion.
//   - standard:      Direct-chat baseline with session-skill bootstrap.
//   - thinking:      Analysis / reasoning. Medium budget + medium reasoning effort.
//   - writer:        Long-form content (reports, articles). High token ceiling.
//   - deep_thinking: Complex multi-step tasks. Maximum quality.
//   - smart:         Legacy alias for thinking tier — same defaults.
//   - pro:           Legacy alias for writer tier — same defaults.
// Output ceilings stay below Sonnet 4.6's 64K max so the same numbers are
// safe on every Claude 4.x model (Opus 4.7 allows 128K; we don't need that
// much in normal direct-chat scenarios and a high cap mostly hurts latency).
// `verbosity` is a GPT-5-only output-length knob (low/medium/high). It is
// ignored by non-GPT-5 models (the adapter only forwards it for GPT-5), so it
// is safe to carry on every tier.
const TIER_DEFAULTS = {
    fast: {
        maxTokens: 4096,
        temperature: 0.2,
        reasoningEffort: undefined, // resolved per-model (GPT-5 → 'minimal'), see applyReasoningDefaults
        reasoningSummary: false,
        verbosity: 'low',
    },
    standard: {
        maxTokens: 16384,
        temperature: 0.5,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'medium',
    },
    swarm: {
        // Swarm tier delegates per-message to a multi-agent runtime; the
        // tier's model is used as the synthesiser default and as the
        // fallback for any worker that doesn't declare its own tier.
        maxTokens: 16384,
        temperature: 0.5,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'medium',
    },
    thinking: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
        verbosity: 'medium',
    },
    writer: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'high',
    },
    deep_thinking: {
        maxTokens: 64000,
        temperature: 0.7,
        reasoningEffort: 'high',
        reasoningSummary: true,
        verbosity: 'high',
    },
    // Legacy aliases
    smart: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'medium',
        reasoningSummary: true,
        verbosity: 'medium',
    },
    pro: {
        maxTokens: 32768,
        temperature: 0.7,
        reasoningEffort: 'low',
        reasoningSummary: false,
        verbosity: 'high',
    },
};

/**
 * Check if EU mode is active — either org-level shield OR personal user preference.
 * Org-level takes priority. If org has shield enabled + euModeEnabled, that wins.
 * If no org OR org has no EU enforcement, check personal user setting.
 *
 * @param {Object}      [opts]
 * @param {string|null}  [opts.userOrgId]  - Org ID to check org-level shield
 * @param {string|null}  [opts.userId]     - User ID to check personal EU preference
 * @returns {Promise<{isEU: boolean, source: 'org'|'user'|'user_shield'|'user_legacy'|'none'}>}
 */
async function isEUModeActive({ userOrgId = null, userId = null } = {}) {
    // 1. Check org-level privacy shield first (takes priority)
    if (userOrgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            return { isEU: true, source: 'org' };
        }
    }

    // 2. Check the user-level Privacy Shield — the canonical store for
    //    per-user EU residency. The consumer Privacy Shield settings panel
    //    writes this key; the EU master toggle requires the shield to be
    //    enabled as well as euModeEnabled, mirroring the org check above.
    if (userId) {
        const userShield = await configStore.getConfig(`user_privacy_shield_${userId}`);
        if (userShield?.enabled && userShield?.euModeEnabled) {
            return { isEU: true, source: 'user_shield' };
        }

        // 3. Fallback for legacy users who set the old `user_eu_mode_${userId}`
        //    flag (the now-removed Startup Agent EU toggle) before the
        //    Privacy Shield panel existed. Keeps EU routing on until they
        //    re-save through the new panel, at which point the new key wins.
        const legacy = await configStore.getConfig(`user_eu_mode_${userId}`);
        if (legacy === true) return { isEU: true, source: 'user_legacy' };
    }

    return { isEU: false, source: 'none' };
}

/**
 * Apply EU tier overrides to a tiers object if EU mode is active.
 * Shared logic used by resolveModelForTier, getTierConfig, and getEUAwareTiers.
 */
async function applyEUOverrides(tiers, { userOrgId = null, userId = null } = {}) {
    const { isEU } = await isEUModeActive({ userOrgId, userId });
    if (!isEU) return tiers;

    const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
    const merged = { ...tiers };
    for (const [tierName, euTier] of Object.entries(euTiers)) {
        if (euTier?.modelId) {
            merged[tierName] = { ...merged[tierName], ...euTier };
        }
    }
    return merged;
}

/**
 * A custom tier (`custom:<slug>`) from the global + org-scoped lists, with its
 * EU model swapped in when EU mode is active; null when there is no such tier.
 *
 * @param {string} id
 * @param {{ userOrgId?: string|null, userId?: string|null }} [opts]
 * @returns {Promise<any|null>}
 */
async function getCustomTierById(id, { userOrgId = null, userId = null } = {}) {
    if (!id || !id.startsWith('custom:')) return null;
    // Merge global + org-scoped custom tiers. Org-scoped tiers override globals
    // when IDs collide (org admin has the final word within their org).
    const globalArr = (await configStore.getConfig('custom_chat_model_tiers')) || [];
    const orgArr = userOrgId
        ? ((await configStore.getConfig(`custom_chat_model_tiers_org_${userOrgId}`)) || [])
        : [];
    const byId = new Map();
    for (const t of (Array.isArray(globalArr) ? globalArr : [])) {
        if (t && t.id) byId.set(t.id, t);
    }
    for (const t of (Array.isArray(orgArr) ? orgArr : [])) {
        if (t && t.id) byId.set(t.id, t);
    }
    const tier = byId.get(id) || null;
    if (!tier) return null;

    // Apply EU override if EU mode is active for this user/org
    const { isEU } = await isEUModeActive({ userOrgId, userId });
    if (isEU && tier.euModelId) {
        return { ...tier, modelId: tier.euModelId };
    }
    return tier;
}

/**
 * Resolve a raw model string to an actual model ID.
 *
 * Handles:
 *   - 'tier:fast'    → looks up chat_model_tiers config
 *   - 'tier:smart'   → looks up chat_model_tiers config
 *   - 'tier:thinking' → looks up chat_model_tiers config
 *   - null/undefined  → falls back to fallbackTier, then global default
 *   - 'gpt-4o'       → returned as-is (already a concrete model ID)
 *
 * @param {string|null} rawModel     - The raw model string from the agent config
 * @param {Object}      [opts]
 * @param {string|null}  [opts.userOrgId]    - Org ID for EU-mode tier overrides
 * @param {string|null}  [opts.userId]       - User ID for personal EU-mode preference
 * @param {string}       [opts.fallbackTier] - Tier to use when rawModel is null (default: 'fast')
 * @returns {Promise<string|null>} Resolved model ID, or null if nothing could be resolved
 */
async function resolveModelForTier(rawModel, { userOrgId = null, userId = null, fallbackTier = 'fast' } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });

    // Case 1: Explicit tier reference (e.g. 'tier:fast' or 'tier:custom:slug')
    if (rawModel && rawModel.startsWith('tier:')) {
        const tierName = rawModel.substring(5);
        if (tierName.startsWith('custom:')) {
            const custom = await getCustomTierById(tierName, { userOrgId, userId });
            return custom?.modelId || tiers[fallbackTier]?.modelId || null;
        }
        return tiers[tierName]?.modelId || tiers[fallbackTier]?.modelId || null;
    }

    // Case 2: No model specified — use fallback tier
    if (!rawModel) {
        return tiers[fallbackTier]?.modelId || null;
    }

    // Case 3: Already a concrete model ID — resolve display-name aliases
    try {
        const { resolveModelId } = require('../aiAgent');
        return resolveModelId(rawModel) || rawModel;
    } catch (_) {
        return rawModel;
    }
}

/**
 * Resolve a model and fall back to the global default if tier resolution fails.
 * A convenience wrapper that guarantees a non-null return (if global config has a model).
 */
async function resolveModelWithGlobalFallback(rawModel, opts = {}) {
    const resolved = await resolveModelForTier(rawModel, opts);
    if (resolved) return resolved;

    // Final fallback: global AI config model
    const { getAIConfig } = require('../aiAgent');
    const globalConfig = await getAIConfig();
    return globalConfig?.model || null;
}

// Legacy `tier:<alias>` values that must be rewritten to a canonical, selectable
// tier before they hit the permission gate or get persisted. `smart` resolves
// fine at runtime (it's a TIER_DEFAULTS alias for `thinking`) but is NOT in the
// permitted-tier allow-list (userTiers.js) nor the UI selector (tierMeta.js), so
// an agent saved with `tier:smart` is rejected by PUT /agents/:id with a 403.
// `pro` is deliberately NOT normalized here — it is a first-class key across the
// allow-list and the UI, so rewriting it would change existing agents' display.
const LEGACY_TIER_ALIASES = { smart: 'thinking' };

/**
 * Normalize a stored/incoming model string, rewriting legacy `tier:<alias>`
 * values to their canonical tier (e.g. `tier:smart` → `tier:thinking`).
 * Non-tier strings and unknown tiers pass through unchanged.
 * @param {*} model
 * @returns {*} the normalized model (same value/type as the input when no alias applies)
 */
function normalizeTierModel(model) {
    if (typeof model !== 'string' || !model.startsWith('tier:')) return model;
    const key = model.slice('tier:'.length);
    const canonical = LEGACY_TIER_ALIASES[key];
    return canonical ? `tier:${canonical}` : model;
}

/**
 * Reduce anything tier-shaped to a BARE canonical tier key, the form the tier
 * maps are actually keyed by (`fast` / `standard` / `thinking` / …).
 *
 * Callers that look a tier up directly — `tiers[name]` — silently miss on the
 * `tier:`-prefixed form and fall back to a different model without saying so.
 * App Studio shipped `modelTier: 'tier:smart'` for exactly that reason and has
 * never once called the smart model. Anyone indexing a tier map should route
 * through here rather than re-deriving the prefix/alias rules.
 *
 * @param {*} value - 'thinking' | 'tier:thinking' | 'smart' | 'tier:smart' | …
 * @returns {string|null} bare canonical tier name, or null when not a string
 */
function canonicalTierName(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const bare = value.startsWith('tier:') ? value.slice('tier:'.length) : value;
    return LEGACY_TIER_ALIASES[bare] || bare;
}

// Order in which a bare model id is matched back to a tier. Cheapest first:
// see findTierKeyForModel for why the order has to be spelled out at all.
// Legacy aliases are absent on purpose — canonicalTierName folds `smart` into
// `thinking`, and `pro` is a first-class key (see LEGACY_TIER_ALIASES).
const TIER_MATCH_PRIORITY = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro', 'deep_thinking'];

/**
 * Which tier a bare model id belongs to, when the caller has nothing better.
 *
 * Several tiers routinely point at the SAME model: the normal case on a
 * self-hosted box with one good model, and common on cloud setups where Fast
 * and Thinking share a model and differ only in effort. A plain
 * `Object.entries(tiers).find(...)` then lets STORAGE ORDER decide, which on
 * Postgres `jsonb` is length-then-bytewise — so `pro` (3 chars) wins over
 * `fast` and every agent silently inherits Deep Thinking's ceiling and
 * reasoning effort. Nobody configured that and nothing reports it.
 *
 * So: match along an explicit ladder, cheapest first. An agent that never
 * asked for deep thinking must not get it by accident; being one tier too
 * cheap costs tokens, being one tier too expensive costs minutes on a
 * single-slot local runtime.
 *
 * This is the LAST resort. A caller that knows which tier it resolved (see
 * agentRuntime/modelResolver.resolveAgentModelWithTier) must pass that instead
 * — the ladder cannot tell `tier:thinking` from `tier:fast` when both point at
 * one model, and guessing there would override an explicit choice.
 *
 * @param {object} tiers - tier map, keyed by bare tier name
 * @param {string} modelId
 * @returns {string|null} the matching tier key, or null when the model is attached to none
 */
function findTierKeyForModel(tiers, modelId) {
    if (!tiers || !modelId) return null;
    for (const key of TIER_MATCH_PRIORITY) {
        if (tiers[key] && tiers[key].modelId === modelId) return key;
    }
    // Custom tiers (`custom:<id>`) and any future key are not on the ladder;
    // fall back to insertion order for those rather than missing them entirely.
    for (const [key, val] of Object.entries(tiers)) {
        if (val && val.modelId === modelId) return key;
    }
    return null;
}

// A La Plateforme model id: a Mistral family name, a dash, and nothing a
// self-hosted name carries (`:` tags, `/` repos, `_` quantisation suffixes).
const MISTRAL_API_ID = /^(mistral|ministral|magistral|codestral|devstral|pixtral)-[a-z0-9.-]+$/i;

/**
 * Returns true when the model id is a known reasoning model that emits
 * thinking / reasoning summary deltas. Used to auto-enable reasoning UX so
 * users see the model's thought process appear before the final answer.
 *
 * Open-weight models served from a local runtime count too: the generic
 * OpenAI-compatible adapter already routes their `reasoning_content` field and
 * their in-band `<think>` tags into the same thinking events (see
 * providers/base.js), so the UX is identical — this is what turns it on.
 * Detection goes through the shared family table in providers/localModels so
 * `qwen3:30b`, `Qwen/Qwen3-30B-A3B` and `Qwen3-30B-Q4_K_M.gguf` all resolve to
 * the same answer.
 */
function isReasoningModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    // OpenAI answers for itself — `^gpt-5` never matched gpt-6, so gpt-6 models
    // silently lost their reasoning summaries (the "thinking" bubbles).
    if (/^gpt-|^o\d/i.test(modelId)) {
        const { describeOpenAIModel } = require('../providers/openaiModels');
        if (describeOpenAIModel(modelId).reasoning) return true;
    }
    // Claude answers from the catalog for the same reason OpenAI does above:
    // the hand-maintained alternation had to be edited on every release.
    if (/claude|anthropic/i.test(modelId)) {
        const { describeClaudeModel } = require('../providers/claudeModels');
        if (describeClaudeModel(modelId).reasoning) return true;
    }
    // Mistral answers from its catalog too: reasoning is a switch on Small 4
    // and Medium 3.5 now, not a separate Magistral family. Only La Plateforme
    // ids — an Ollama tag (`mistral-small3.2:24b`) or a HF/GGUF name is a
    // self-hosted model and is answered by the local table below.
    if (MISTRAL_API_ID.test(modelId)) {
        const { describeMistralModel } = require('../providers/mistralModels');
        if (describeMistralModel(modelId).reasoning) return true;
    }
    if (/gemini-(2\.5|3)/i.test(modelId)) {
        return true;
    }
    try {
        const { describeLocalModel } = require('../providers/localModels');
        return describeLocalModel(modelId).reasoning;
    } catch (_) {
        return false;
    }
}

/**
 * The cheapest reasoning tier a model offers that still does some reasoning.
 * `none` is skipped: the fast tier wants speed, not reasoning switched off —
 * turning it off entirely is a separate, explicit choice.
 *
 * Returns null for other models, which keep the generic 'medium' default.
 * OpenAI and Mistral answer from their catalogs; for Mistral that answer is
 * `none` (see mistralModels.cheapestMistralEffort).
 */
function _cheapestEffort(modelId) {
    // Mistral's switch is none/high: no cheap reasoning level exists, so a
    // speed tier gets `none` rather than the generic 'medium' — which would
    // map to `high`, the slowest setting there is.
    if (MISTRAL_API_ID.test(modelId || '')) {
        const { cheapestMistralEffort } = require('../providers/mistralModels');
        return cheapestMistralEffort(modelId);
    }
    if (!/^gpt-|^o\d/i.test(modelId || '')) return null;
    const { describeOpenAIModel } = require('../providers/openaiModels');
    const { efforts } = describeOpenAIModel(modelId);
    if (!efforts) return null;
    return efforts.find(e => e !== 'none') || null;
}

/**
 * Apply reasoning-model defaults: when the resolved model supports thinking
 * summaries, turn them on unless the user explicitly disabled them. We only
 * upgrade `undefined` → enabled — explicit `false` from the admin or custom
 * tier config is respected.
 */
function applyReasoningDefaults(merged, userConfig, tierName) {
    if (!merged?.modelId || !isReasoningModel(merged.modelId)) return merged;
    const userSetSummary  = Object.prototype.hasOwnProperty.call(userConfig || {}, 'reasoningSummary');
    const userSetEffort   = Object.prototype.hasOwnProperty.call(userConfig || {}, 'reasoningEffort');
    if (!userSetSummary && (merged.reasoningSummary === undefined || merged.reasoningSummary === false)) {
        merged.reasoningSummary = true;
    }
    if (!userSetEffort && (merged.reasoningEffort === undefined || merged.reasoningEffort === null)) {
        // The fast/swarm tiers are tuned for speed, so ask for the cheapest
        // reasoning tier the model actually has. That used to be a flat
        // 'minimal' for anything matching /^gpt-5/ — but 'minimal' was retired
        // in gpt-5.6 and never existed on gpt-6, where sending it is a 400.
        // Ask the model what its cheapest tier is instead of assuming.
        const isFastTier = tierName === 'fast' || tierName === 'swarm';
        merged.reasoningEffort = isFastTier
            ? (_cheapestEffort(merged.modelId) || 'medium')
            : 'medium';
    }
    return merged;
}

/**
 * Get the full tier config object (for endpoints that need maxTokens, temperature, etc.)
 *
 * Merges: TIER_DEFAULTS (baseline) ← user config (admin UI overrides).
 * User-set values always win; TIER_DEFAULTS fill in anything the user hasn't configured.
 *
 * Reasoning-capable models auto-enable `reasoningSummary` + a `medium`
 * reasoningEffort so users see the model's thought process stream before
 * the final answer (parallel to the typing-dots/phase indicator).
 */
async function getTierConfig(tierName, { userOrgId = null, userId = null } = {}) {
    // Custom tiers carry their own full config — no TIER_DEFAULTS fallback needed.
    if (tierName && tierName.startsWith('custom:')) {
        const custom = await getCustomTierById(tierName, { userOrgId, userId });
        if (custom) {
            const merged = {
                maxTokens: custom.maxTokens,
                temperature: custom.temperature,
                reasoningEffort: custom.reasoningEffort,
                reasoningSummary: custom.reasoningSummary,
                verbosity: custom.verbosity,
                modelId: custom.modelId,
            };
            return applyReasoningDefaults(merged, custom, tierName);
        }
        // Fall through to fast defaults if the id is unknown
    }
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    tiers = await applyEUOverrides(tiers, { userOrgId, userId });
    const userConfig = tiers[tierName] || tiers['fast'] || {};
    const defaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    // Merge: defaults provide baselines, user config overrides
    const merged = { ...defaults, ...userConfig };
    return applyReasoningDefaults(merged, userConfig, tierName);
}

/**
 * Convenience: resolve a plain tier name (e.g. 'fast', 'smart') to a model ID.
 * Shorthand for resolveModelForTier('tier:' + tierName, opts).
 *
 * `fallback` IS OPT-IN — it defaults to null, and a caller that does not name
 * one gets null when nothing is configured. It used to default to a hardcoded
 * `gemini-2.0-flash-lite`, which meant this function could never return
 * anything falsy: every "is a model configured at all?" gate downstream was
 * unreachable, and a workspace that never chose that Google model had text
 * routed to it anyway — outside its own tier choice and outside the EU
 * overrides. On a privacy product "which model saw this text" is not a detail,
 * so the answer to "nobody configured one" is a readable refusal from the
 * caller, not a model picked here.
 *
 * Note the two distinct outcomes, which callers must keep apart: this function
 * RETURNS null when nothing is configured, and THROWS when the config could not
 * be read. Both should refuse; neither should fall back.
 *
 * @param {string} tierName      - Plain tier name (e.g. 'fast', 'smart', 'thinking')
 * @param {Object} [opts]
 * @param {string|null} [opts.userOrgId] - Org ID for EU-mode overrides
 * @param {string|null} [opts.userId]    - User ID for personal EU-mode preference
 * @param {string|null} [opts.fallback]  - OPT-IN fallback model ID; null (default) means
 *                                       "no model configured" is a real answer
 * @returns {Promise<string|null>} Resolved model ID, or null when nothing is configured
 */
async function resolveModelForTierName(tierName, { userOrgId = null, userId = null, fallback = null } = {}) {
    const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId, userId, fallbackTier: 'fast' });
    return resolved || fallback || null;
}

/**
 * Get the full EU-aware tiers map (merged with EU overrides if applicable).
 * Useful for consumers that need to iterate available tiers (e.g. promptClassifier).
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.userOrgId] - Org ID for EU-mode overrides
 * @param {string|null} [opts.userId]    - User ID for personal EU-mode preference
 * @returns {Promise<Object>} Merged tiers config
 */
async function getEUAwareTiers({ userOrgId = null, userId = null } = {}) {
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    return applyEUOverrides(tiers, { userOrgId, userId });
}

/**
 * The COMPLETE tier map a user can actually pick from: EU-aware base tiers
 * merged with global + org custom tiers (org wins on id collisions, EU model
 * override honoured). This is the single source of truth for "which tiers
 * exist for this user" — the chat dropdown, the automation builder, and the
 * ai_step runtime all resolve against it (previously three hand-copied
 * merge blocks that could drift).
 */
async function getUserTierMap({ userOrgId = null, userId = null } = {}) {
    const tiers = await getEUAwareTiers({ userOrgId, userId });
    try {
        const { isEU } = await isEUModeActive({ userOrgId, userId });
        const globalCustom = (await configStore.getConfig('custom_chat_model_tiers')) || [];
        const orgCustom = userOrgId
            ? ((await configStore.getConfig(`custom_chat_model_tiers_org_${userOrgId}`)) || [])
            : [];
        const byId = new Map();
        for (const t of (Array.isArray(globalCustom) ? globalCustom : [])) if (t?.id) byId.set(t.id, t);
        for (const t of (Array.isArray(orgCustom)    ? orgCustom    : [])) if (t?.id) byId.set(t.id, t);
        for (const t of byId.values()) {
            tiers[t.id] = {
                modelId: isEU && t.euModelId ? t.euModelId : t.modelId,
                label: t.label, icon: t.icon, description: t.description,
                maxTokens: t.maxTokens, temperature: t.temperature,
                reasoningEffort: t.reasoningEffort, reasoningSummary: t.reasoningSummary,
                custom: true,
            };
        }
    } catch (_) { /* fall through without custom tiers */ }
    return tiers;
}

// ─── Effective tier-org resolution (M2) ──────────────────────────────────────
// [PERF] The chat surfaces resolved the user's org for tier selection by, on
// every message, calling resolveUserOrgIds(req) and — for super-admins / users
// with no direct org — falling back to getUser() + a FULL `SELECT * FROM groups`
// scan (getAllGroups + per-row JSON.parse ×6). This memoises the RESOLVED org id
// per (user, skipGroupFallback) for a short TTL so the scan collapses to one
// lookup per user per ~45s.
//
// SECURITY: the cached value is for TIER / model / EU-model selection only. It
// must NEVER back an authz or subscription-limit DENIAL — resolveUserOrgIds
// (auth) and resolveOrgId (limits) stay uncached so a revoked membership /
// suspended plan takes effect on the very next request. A stale tier-org only
// risks a just-moved user briefly seeing their old org's tier/EU-model choice.
const _effectiveOrgCache = createTtlCache({ ttlMs: 45_000, max: 2000 });

/**
 * @param {any} req
 * @param {{ userId?: string|null, skipGroupFallback?: boolean }} [opts]
 */
async function resolveEffectiveOrgId(req, { userId, skipGroupFallback = false } = {}) {
    const uid = userId || req?.session?.user?.id || null;
    const cacheKey = uid ? `${uid}|${skipGroupFallback ? 'nogrp' : 'grp'}` : null;
    if (cacheKey) {
        const hit = _effectiveOrgCache.get(cacheKey);
        if (hit !== undefined) return hit;
    }

    const { resolveUserOrgIds } = require('../../auth/permissions');
    const userStore = require('../../stores/userStore');

    let orgId = null;
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds && orgIds.size > 0) {
        orgId = Array.from(orgIds)[0];
    } else if (uid) {
        // Super admin (null set) or a user with no direct org — resolve from DB.
        try {
            const dbUser = await userStore.getUser(uid);
            if (dbUser?.organizationId) {
                orgId = dbUser.organizationId;
            } else if (!skipGroupFallback) {
                const groups = Array.isArray(dbUser?.groups)
                    ? dbUser.groups
                    : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch (_) { return []; } })();
                if (groups.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    for (const gid of groups) {
                        const g = allGroups.find(gr => gr.id === gid);
                        if (g?.organizationId) { orgId = g.organizationId; break; }
                    }
                }
            }
        } catch (_) { /* fall through to null */ }
    }

    if (cacheKey) _effectiveOrgCache.set(cacheKey, orgId);
    return orgId;
}

module.exports = {
    TIER_DEFAULTS,
    TIER_MATCH_PRIORITY,
    findTierKeyForModel,
    normalizeTierModel,
    canonicalTierName,
    resolveModelForTier,
    resolveModelWithGlobalFallback,
    getTierConfig,
    resolveModelForTierName,
    getEUAwareTiers,
    getUserTierMap,
    resolveEffectiveOrgId,
    isEUModeActive,
    getCustomTierById,
    isReasoningModel,
};
