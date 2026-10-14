/**
 * AI Config — model tier configuration: standard/EU/custom/org tiers, the
 * auto-classifier and title-generation models, Claude settings, hidden
 * models and the per-user tier resolution.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { requireAuth } = require('../../../auth/permissions');
const { z, typeError } = require('../../../utils/zod');
const { validate } = require('../../../core/http/validate');
const { requireAdminUser } = require('../requireAdminUser');

const requireAdmin = requireAdminUser(isAdminUser);

/** The auto-tier classifier caches its model; a changed tier or classifier model must reach it. */
function clearClassifierCache() {
    try { require('../../../core/llm/promptClassifier').clearClassifierCache(); } catch (_) { /* non-fatal */ }
}

// ── What a caller may send ────────────────────────────────────────────────
// Six of these routes set one model id, and each had its own copy of
// "a string, trimmed, or null". The schema says it once, and `.strict()`
// turns a misspelled key into a 400 instead of a silent no-op: the admin
// screens here save on a toggle, so a request that quietly did nothing is
// indistinguishable from one that worked.

const MODEL_ID_TEXT = 'A model id must be text; send null to clear it.';
/** Clearing the setting is what an empty or absent value means, as before. */
const ModelIdBody = z.object({
    modelId: z.string({ error: typeError({ invalid: MODEL_ID_TEXT }) }).trim().nullish()
        .transform((v) => v || null),
}).strict();

const HIDDEN_MODELS_TEXT = 'modelIds must be an array';
const HiddenModelsBody = z.object({
    modelIds: z.array(z.string({ error: typeError({ invalid: 'Each hidden model id must be text.' }) }).trim(),
        { error: HIDDEN_MODELS_TEXT })
        // A blocklist is a set: blanks carry nothing and a repeat hides the
        // same model twice.
        .transform((ids) => [...new Set(ids.filter(Boolean))]),
}).strict();

const ClaudeSettingsBody = z.object({
    autoRetryOnEmpty: z.boolean({ error: typeError({ invalid: 'autoRetryOnEmpty is true or false.' }) }).default(true),
}).strict();

// ─── Model Tier Config ───────────────────────────────────────────

router.get('/config/chat-models', requireAuth, async (req, res) => {
    const tiers = await configStore.getConfig('chat_model_tiers') || {
        fast: { modelId: '', label: 'Fast' },
        standard: { modelId: '', label: 'Flow (Direct)' },
        swarm: { modelId: '', label: 'Swarm (Direct)' },
        thinking: { modelId: '', label: 'Thinking' },
        writer: { modelId: '', label: 'Writer' },
        pro: { modelId: '', label: 'Pro' }
    };
    if (!tiers.writer) tiers.writer = { modelId: '', label: 'Writer' };
    if (!tiers.standard) tiers.standard = { modelId: '', label: 'Flow (Direct)' };
    if (!tiers.swarm) tiers.swarm = { modelId: '', label: 'Swarm (Direct)' };
    res.json(tiers);
});

router.post('/config/chat-models', requireAuth, requireAdmin, async (req, res) => {
    const { fast, standard, swarm, thinking, writer, pro } = req.body;
    const tiers = {
        fast: fast || { modelId: '', label: 'Fast' },
        standard: standard || { modelId: '', label: 'Flow (Direct)' },
        swarm: swarm || { modelId: '', label: 'Swarm (Direct)' },
        thinking: thinking || { modelId: '', label: 'Thinking' },
        writer: writer || { modelId: '', label: 'Writer' },
        pro: pro || { modelId: '', label: 'Pro' }
    };
    await configStore.setConfig('chat_model_tiers', tiers);
    clearClassifierCache();
    res.json({ success: true });
});

// ─── Single-model settings ───────────────────────────────────────
// Each of these is one admin-only config key holding a model id (or null for
// "unset"): GET reads it, POST checks the id against the configured providers
// and stores it. The routes differ only in their path and config key.

/**
 * Registers GET and POST `path` for the model id stored under `configKey`.
 * The POST runs the schema before the admin gate, as these routes always did.
 *
 * @param {string} path
 * @param {string} configKey
 * @param {{ afterSave?: () => void }} [options]
 */
function modelIdSetting(path, configKey, { afterSave } = {}) {
    router.get(path, requireAuth, requireAdmin, async (req, res) => {
        const modelId = await configStore.getConfig(configKey);
        res.json({ modelId: typeof modelId === 'string' ? modelId : null });
    });

    router.post(path, requireAuth, validate({ body: ModelIdBody }), requireAdmin, async (req, res) => {
        const { modelId } = req.body;

        if (modelId) {
            const { getProviderForModel } = require('../../../core/aiAgent');
            try {
                await getProviderForModel(modelId);
            } catch (_) {
                return res.status(400).json({ error: `Model "${modelId}" not found in any configured provider` });
            }
        }

        await configStore.setConfig(configKey, modelId);
        if (afterSave) afterSave();
        res.json({ success: true, modelId });
    });
}

// ─── Auto-tier Classifier Model ──────────────────────────────────
// The classifier picks a tier for Auto-mode prompts. It runs an LLM
// call only on ambiguous prompts (the heuristic shortcut handles the
// easy 60–70%). Admins can pin the cheapest/fastest model here so the
// classification call is as snappy as possible. When unset, falls back
// to the Fast tier model.
modelIdSetting('/config/auto-classifier', 'auto_classifier_model', { afterSave: clearClassifierCache });

// ─── Title-generation Model ──────────────────────────────────────
// Conversation titles are a tiny, tool-free LLM call. By default the
// title generator inherits the Fast tier model, but admins often want
// the very cheapest model here (a heavy Fast tier shouldn't make titling
// expensive). When unset, falls back to the title system-agent config and
// then the Fast tier.
modelIdSetting('/config/title-model', 'title_generation_model');

// ─── Memory-extraction Model ─────────────────────────────────────
// After every reply two background extractors read the exchange for
// facts worth remembering (core/memoryExtractor.js, agents/memory/
// extractor.js). They inherit the Fast tier by default. On a single-slot
// self-hosted server that is the SAME model the chat just used, so each
// extraction is another full prompt evaluation queued behind the next
// turn — a tiny dedicated model (or a hosted one) keeps the slot free.
// Unset = Fast tier, exactly as before. Same shape as the title model.
modelIdSetting('/config/memory-extraction-model', 'memory_extraction_model');

// ─── Data-extraction Model ───────────────────────────────────────
// The model every automation `data_extraction` step runs on, whatever tier the
// automation uses (core/automationRunner/dataExtractionModel.js). Extraction
// wants one small, fast, deterministic model with thinking off, not the 26B
// chat model the tier happens to name — and on the single-slot local box the
// tier's model is the one the builder itself runs on, so extracting through
// it evicts the builder's prompt cache. Unset = the Fast tier's model, then
// the global default. Same shape as the memory-extraction model above.
modelIdSetting('/config/data-extraction-model', 'data_extraction_model');

// ─── AI step model (TEMPORARY override) ─────────────────────────
// An automation's ai_step inherits the tier the builder wrote for it — `auto` or
// `fast` — which on the single-slot local box is the very model the builder
// runs on: one dry run then evicts the builder's prompt cache and queues
// several full prompt evaluations before the next round. With this key set,
// every ai_step on the default tier runs on the named model; steps that
// explicitly picked a heavier tier keep it (core/automationRunner/aiStepModel.js).
// Unset = the step's own tier, exactly as before. Same shape as the title model.
modelIdSetting('/config/ai-step-model', 'ai_step_model');

// ─── Builder narration Model ─────────────────────────────────────
// While the Automation Builder reasons, a tiny side model rewrites a window
// of the reasoning stream into one short phrase for the canvas
// (routes/ai/automationBuilder/thoughtNarrator.js). It is called every few
// seconds during a build, so it wants the smallest model available — locally
// that is lfm2.5-350m on the llama-server router. Unset = the narrated line
// is off and the client falls back to its own heuristics. Validated against
// the configured providers so a typo is a 400 here, not a silent no-op that
// only shows as a build with no narration.
modelIdSetting('/config/builder-narration-model', 'builder_narration_model');

// ─── Claude-specific settings ────────────────────────────────────
// Global knobs that only apply to Anthropic Claude models. Per-tier
// settings (model, max_tokens, effort, budget_tokens) live in the
// regular chat_model_tiers config; this endpoint exists for the
// cross-tier robustness toggles.
//
// auto_retry_on_empty — when a Claude turn returns stop_reason=max_tokens
// (or any path where thinking ate the budget and the final text is empty),
// kick off ONE follow-up non-streaming call with reasoningEffort='none' so
// the model writes a real answer based on what it already thought. Default
// true; flip off if you'd rather see the raw "no response" symptom.

router.get('/config/claude-settings', requireAuth, async (req, res) => {
    const settings = (await configStore.getConfig('claude_settings')) || {};
    res.json({
        autoRetryOnEmpty: settings.autoRetryOnEmpty !== false, // default true
    });
});

router.post('/config/claude-settings', requireAuth, validate({ body: ClaudeSettingsBody }), requireAdmin, async (req, res) => {
    const settings = { autoRetryOnEmpty: req.body.autoRetryOnEmpty };
    await configStore.setConfig('claude_settings', settings);
    res.json({ success: true, ...settings });
});

// ─── Hidden Models (global blocklist) ────────────────────────────
// Admins can hide specific model IDs from every tier picker (Fast, Flow,
// Thinking, etc.). Stored as a flat array of model IDs under
// `hidden_model_ids`. The list is purely cosmetic — it does NOT remove the
// model from the provider catalog, just from the picker UI.

router.get('/config/hidden-models', requireAuth, async (req, res) => {
    const raw = await configStore.getConfig('hidden_model_ids');
    const ids = Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
    res.json({ modelIds: ids });
});

router.post('/config/hidden-models', requireAuth, validate({ body: HiddenModelsBody }), requireAdmin, async (req, res) => {
    const ids = req.body.modelIds;
    await configStore.setConfig('hidden_model_ids', ids);
    res.json({ success: true, modelIds: ids });
});


// ─── EU Model Tier Config ────────────────────────────────────────

router.get('/config/chat-models-eu', requireAuth, async (req, res) => {
    const tiers = await configStore.getConfig('chat_model_tiers_eu') || {
        fast: { modelId: '', label: 'Fast' },
        standard: { modelId: '', label: 'Flow (Direct)' },
        swarm: { modelId: '', label: 'Swarm (Direct)' },
        thinking: { modelId: '', label: 'Thinking' },
        writer: { modelId: '', label: 'Writer' },
        pro: { modelId: '', label: 'Pro' }
    };
    if (!tiers.standard) tiers.standard = { modelId: '', label: 'Flow (Direct)' };
    if (!tiers.swarm) tiers.swarm = { modelId: '', label: 'Swarm (Direct)' };
    res.json(tiers);
});

router.post('/config/chat-models-eu', requireAuth, requireAdmin, async (req, res) => {
    const { fast, standard, swarm, thinking, writer, pro } = req.body;
    const tiers = {
        fast: fast || { modelId: '', label: 'Fast' },
        standard: standard || { modelId: '', label: 'Flow (Direct)' },
        swarm: swarm || { modelId: '', label: 'Swarm (Direct)' },
        thinking: thinking || { modelId: '', label: 'Thinking' },
        writer: writer || { modelId: '', label: 'Writer' },
        pro: pro || { modelId: '', label: 'Pro' }
    };

    // Validate that specified model IDs exist in configured providers
    const warnings = [];
    const notInEu = [];
    const { getProviderForModel } = require('../../../core/aiAgent');
    const { isEuResidencyUrl } = require('../../../core/providers/openaiModels');
    for (const [tierName, tierConfig] of Object.entries(tiers)) {
        if (!tierConfig.modelId) continue;
        let cfg = null;
        try {
            cfg = await getProviderForModel(tierConfig.modelId);
        } catch (_) {
            warnings.push(`EU tier "${tierName}": model "${tierConfig.modelId}" not found in any configured provider`);
            continue;
        }
        // These are the models EU mode routes to. OpenAI can serve them from
        // inside the EU, but only through its regional-processing endpoint —
        // the default domain processes in the US. Refuse rather than warn:
        // a tier saved here is what an org with "EU only" switched on will
        // actually be sent to, and a warning nobody reads is not a control.
        const isOpenAILike = cfg?.providerType === 'openai' || cfg?.providerType === 'azure';
        if (isOpenAILike && cfg?.providerType === 'openai' && !isEuResidencyUrl(cfg.url)) {
            notInEu.push(`"${tierConfig.modelId}" (tier ${tierName}) — provider "${cfg.providerName}" points at ${cfg.url || 'the default US endpoint'}`);
        }
    }

    if (notInEu.length > 0) {
        return res.status(400).json({
            error: 'EU tiers may only use models that are actually served from the EU.',
            detail: notInEu,
            hint: 'Switch the OpenAI provider to EU regional processing (https://eu.api.openai.com/v1) in AI Settings → Providers, or pick a model from an EU-hosted provider.',
        });
    }

    await configStore.setConfig('chat_model_tiers_eu', tiers);
    clearClassifierCache();
    if (warnings.length > 0) {
        log.warn('[Config] EU tier validation warnings:', warnings);
    }
    res.json({ success: true, warnings });
});

// ─── Custom Chat Model Tiers ─────────────────────────────────────

const VALID_TASK_TYPES = ['direct_chat', 'agent_chat'];
const STANDARD_TIER_KEYS = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

// ── Custom tier helpers ──────────────────────────────────────────
async function isOrgAdmin(req) {
    if (await isAdminUser(req)) return true;
    const userId = req.session.user?.id;
    if (!userId) return false;
    const perms = await require('../../../auth/permissions').getUserPermissions(userId, req.session);
    return perms.includes('all') || perms.includes('org_admin') || perms.includes('manage_users');
}

async function resolveSessionOrgId(req) {
    if (req.session.user?.organizationId) return req.session.user.organizationId;
    try {
        const userStore = require('../../../stores/userStore');
        const u = await userStore.getUser(req.session.user?.id);
        if (u?.organizationId) return u.organizationId;
        // Fallback: first group's org
        const groups = Array.isArray(u?.groups) ? u.groups : [];
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            for (const gid of groups) {
                const g = allGroups.find(gr => gr.id === gid);
                if (g?.organizationId) return g.organizationId;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

async function loadGlobalCustomTiers() {
    const arr = await configStore.getConfig('custom_chat_model_tiers') || [];
    return Array.isArray(arr) ? arr : [];
}

async function loadOrgCustomTiers(orgId) {
    if (!orgId) return [];
    const arr = await configStore.getConfig(`custom_chat_model_tiers_org_${orgId}`) || [];
    return Array.isArray(arr) ? arr : [];
}

// Merge global + org tiers into a single array with stable ordering.
// When IDs collide, the org tier wins (org admin has final word in their org).
// Each tier gets a `_scope` field ('global' | 'org') so the UI can show badges.
async function loadMergedCustomTiers(orgId) {
    const globalTiers = await loadGlobalCustomTiers();
    const orgTiers = orgId ? await loadOrgCustomTiers(orgId) : [];
    const byId = new Map();
    for (const t of globalTiers) if (t && t.id) byId.set(t.id, { ...t, _scope: 'global' });
    for (const t of orgTiers) if (t && t.id) byId.set(t.id, { ...t, _scope: 'org' });
    return Array.from(byId.values());
}

function normalizeCustomTier(t) {
    if (!t || typeof t !== 'object') return null;
    const id = typeof t.id === 'string' && t.id.startsWith('custom:') ? t.id : null;
    if (!id) return null;
    const allowedTaskTypes = Array.isArray(t.allowedTaskTypes)
        ? t.allowedTaskTypes.filter(tt => VALID_TASK_TYPES.includes(tt))
        : [];
    return {
        id,
        label: String(t.label || id.replace(/^custom:/, '')),
        icon: typeof t.icon === 'string' ? t.icon : '✨',
        description: typeof t.description === 'string' ? t.description : '',
        modelId: typeof t.modelId === 'string' ? t.modelId : '',
        // Optional EU-hosted override used when the org's Privacy Shield forces EU mode.
        // Empty string → no override; falls back to the global modelId.
        euModelId: typeof t.euModelId === 'string' ? t.euModelId : '',
        maxTokens: Number.isFinite(t.maxTokens) ? t.maxTokens : 16384,
        temperature: Number.isFinite(t.temperature) ? t.temperature : 0.7,
        reasoningEffort: typeof t.reasoningEffort === 'string' ? t.reasoningEffort : undefined,
        reasoningSummary: !!t.reasoningSummary,
        allowedTaskTypes,
    };
}

router.get('/config/custom-chat-models', requireAuth, requireAdmin, async (req, res) => {
    const tiers = await configStore.getConfig('custom_chat_model_tiers') || [];
    res.json({ tiers: Array.isArray(tiers) ? tiers : [] });
});

router.post('/config/custom-chat-models', requireAuth, requireAdmin, async (req, res) => {
    const { tiers } = req.body;
    if (!Array.isArray(tiers)) {
        return res.status(400).json({ error: '`tiers` must be an array' });
    }
    const normalized = tiers.map(normalizeCustomTier).filter(Boolean);
    // Dedupe by id — last occurrence wins
    const seen = new Map();
    for (const t of normalized) seen.set(t.id, t);
    const finalTiers = Array.from(seen.values());

    const warnings = [];
    const { getProviderForModel } = require('../../../core/aiAgent');
    for (const t of finalTiers) {
        if (t.modelId) {
            try { await getProviderForModel(t.modelId); }
            catch (_) { warnings.push(`Custom tier "${t.id}": model "${t.modelId}" not found in any configured provider`); }
        }
    }
    await configStore.setConfig('custom_chat_model_tiers', finalTiers);
    if (warnings.length > 0) log.warn('[Config] Custom tier validation warnings:', warnings);
    res.json({ success: true, warnings, tiers: finalTiers });
});

// Lightweight tier list for org-admin group editor — metadata only (id, label, icon, scope)
// Returns global + the caller's org tiers merged.
router.get('/config/custom-tiers-list', requireAuth, async (req, res) => {
    const orgId = await resolveSessionOrgId(req);
    const tiers = await loadMergedCustomTiers(orgId);
    const list = tiers.map(t => ({
        id: t.id, label: t.label, icon: t.icon, description: t.description,
        allowedTaskTypes: t.allowedTaskTypes || [],
        scope: t._scope || 'global',
    }));
    res.json({ tiers: list });
});

// ─── Org-scoped Custom Tiers (org admin) ─────────────────────────
// Operates on custom_chat_model_tiers_org_{orgId}. Org admins may create/edit
// tiers that are scoped to their organization. Super admins may use this on
// any org by passing ?orgId=xxx; org admins implicitly target their own org.
router.get('/config/org-custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isOrgAdmin(req))) return res.status(403).json({ error: 'Org admin access required' });
    let orgId = await isAdminUser(req) && typeof req.query.orgId === 'string' && req.query.orgId
        ? req.query.orgId
        : await resolveSessionOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation resolved for this user' });
    const globalTiers = await loadGlobalCustomTiers();
    const orgTiers = await loadOrgCustomTiers(orgId);
    res.json({
        orgId,
        orgTiers,
        // Returned for reference (read-only in this editor) so the org admin
        // can see which tiers are already provided globally.
        globalTiers: globalTiers.map(t => ({
            id: t.id, label: t.label, icon: t.icon, description: t.description,
            allowedTaskTypes: t.allowedTaskTypes || [],
        })),
    });
});

router.post('/config/org-custom-chat-models', requireAuth, async (req, res) => {
    if (!(await isOrgAdmin(req))) return res.status(403).json({ error: 'Org admin access required' });
    let orgId = await isAdminUser(req) && typeof req.body.orgId === 'string' && req.body.orgId
        ? req.body.orgId
        : await resolveSessionOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation resolved for this user' });

    const { tiers } = req.body;
    if (!Array.isArray(tiers)) {
        return res.status(400).json({ error: '`tiers` must be an array' });
    }
    const normalized = tiers.map(normalizeCustomTier).filter(Boolean);
    const seen = new Map();
    for (const t of normalized) seen.set(t.id, t);
    const finalTiers = Array.from(seen.values());

    const warnings = [];
    const { getProviderForModel } = require('../../../core/aiAgent');
    for (const t of finalTiers) {
        if (t.modelId) {
            try { await getProviderForModel(t.modelId); }
            catch (_) { warnings.push(`Custom tier "${t.id}": model "${t.modelId}" not found in any configured provider`); }
        }
        if (t.euModelId) {
            try { await getProviderForModel(t.euModelId); }
            catch (_) { warnings.push(`Custom tier "${t.id}": EU model "${t.euModelId}" not found in any configured provider`); }
        }
    }
    await configStore.setConfig(`custom_chat_model_tiers_org_${orgId}`, finalTiers);
    if (warnings.length > 0) log.warn(`[Config] Org ${orgId} custom tier warnings:`, warnings);
    res.json({ success: true, orgId, warnings, tiers: finalTiers });
});

// Returns tiers a given user may use, optionally filtered by taskType.
// Shape matches the existing /config/chat-models consumer: { fast: {...}, thinking: {...}, ..., 'custom:xyz': {...} }
router.get('/config/tiers-for-user', requireAuth, async (req, res) => {
    const taskType = typeof req.query.taskType === 'string' ? req.query.taskType : null;
    const userId = req.session.user?.id;
    const userOrgId = req.session.user?.organizationId;

    const userStore = require('../../../stores/userStore');
    const { getEUAwareTiers } = require('../../../core/llm/modelResolver');

    // Standard tiers (already EU-aware) — always included, unrestricted by the plan's permission model
    const standardTiers = await getEUAwareTiers({ userOrgId, userId });

    // Custom tiers (global + org-scoped, with org taking precedence on id collision)
    const customTiers = await loadMergedCustomTiers(userOrgId);
    // EU override: when EU mode is active, swap modelId for euModelId (if set).
    const { isEUModeActive } = require('../../../core/llm/modelResolver');
    const { isEU } = await isEUModeActive({ userOrgId, userId });
    if (isEU) {
        for (const t of customTiers) {
            if (t.euModelId) t.modelId = t.euModelId;
        }
    }

    // Resolve user's group ids
    const user = userId ? await userStore.getUser(userId) : null;
    const userGroupIds = Array.isArray(user?.groups) ? user.groups : [];
    const allGroups = await userStore.getAllGroups();
    const userGroups = allGroups.filter(g => userGroupIds.includes(g.id));

    // A tier is permitted if ANY of the user's groups:
    //   (a) has allowedTiers empty/unset (no restriction), OR
    //   (b) lists the tier id in allowedTiers.
    // If the user has NO groups, treat as unrestricted (matches getUser default behaviour).
    function tierPermittedByGroups(tierId) {
        if (userGroups.length === 0) return true;
        return userGroups.some(g => {
            const list = Array.isArray(g.allowedTiers) ? g.allowedTiers : [];
            return list.length === 0 || list.includes(tierId);
        });
    }

    // The Flow tier (key 'standard') requires BOTH the `flow` beta (the
    // tier opt-in) and the `skills` beta (its runtime dependency: Flow
    // bootstraps chat-local session skills). The Swarm tier depends on
    // the `swarm` beta. Hide either tier when the caller's org/user
    // doesn't have the required feature(s).
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    const hasSkillsFeature = userId
        ? await userHasBetaFeature(userId, 'skills', req.session).catch(() => false)
        : false;
    const hasFlowFeature = userId
        ? await userHasBetaFeature(userId, 'flow', req.session).catch(() => false)
        : false;
    const hasSwarmFeature = userId
        ? await userHasBetaFeature(userId, 'swarm', req.session).catch(() => false)
        : false;
    const hasFlowTier = hasFlowFeature && hasSkillsFeature;

    const result = {};
    // Auto is a meta/routing tier (no concrete modelId) — always include it
    // when permitted by groups so the client's persisted 'auto' selection
    // survives the post-fetch reconciliation in AgentHub.
    if (tierPermittedByGroups('auto')) {
        result.auto = { auto: true };
    }
    // Standard
    for (const key of STANDARD_TIER_KEYS) {
        // Direct-chat-only tiers: never expose for non-direct tasks.
        if ((key === 'standard' || key === 'swarm') && taskType !== 'direct_chat') continue;
        // Beta gates: Flow uses `skills`, Swarm uses `swarm`.
        if (key === 'standard' && !hasFlowTier) continue;
        if (key === 'swarm' && !hasSwarmFeature) continue;
        if (!tierPermittedByGroups(key)) continue;
        if (standardTiers && standardTiers[key]) result[key] = standardTiers[key];
    }
    // Custom
    for (const t of (Array.isArray(customTiers) ? customTiers : [])) {
        // v1 carve-out (C27): taskType 'automation' does not filter custom
        // tiers by allowedTaskTypes — existing custom tiers pre-date any
        // "Automations" checkbox, filtering would strip them from live
        // automations. Mirrors core/userTiers.getPermittedTierKeys.
        if (taskType && taskType !== 'automation' && !(t.allowedTaskTypes || []).includes(taskType)) continue;
        if (!tierPermittedByGroups(t.id)) continue;
        result[t.id] = {
            modelId: t.modelId,
            label: t.label,
            icon: t.icon,
            description: t.description,
            maxTokens: t.maxTokens,
            temperature: t.temperature,
            reasoningEffort: t.reasoningEffort,
            reasoningSummary: t.reasoningSummary,
            custom: true,
        };
    }
    res.json(result);
});

module.exports = router;
