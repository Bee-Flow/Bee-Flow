// @typecheck
/**
 * The per-provider model list, cached, and the lookup over it.
 *
 * Discovery (`adapter.listModels`) is a network call per provider, and the
 * chat path asks "which provider serves this model" on every turn, so the
 * lists are cached: in Redis when there is one (shared across instances and
 * surviving a restart), else in this process for MODEL_CACHE_TTL seconds.
 *
 * Every return path also stamps the cost registries (self-hosted → €0,
 * Scaleway → Scaleway's tariff, EU-resident OpenAI → the uplift), because
 * those registries are per process while the Redis cache is not: a freshly
 * restarted server serving a warm cache would otherwise bill a self-hosted
 * model at cloud rates until the entry expired.
 */

const configStore = require('../../stores/configStore');
const { getRedis } = require('../../db');
const log = require('../../telemetry/log');
const { isLocalProviderType, registerLocalModel } = require('../providers/localModels');
const { registerScalewayModel } = require('../providers/scalewayModels');
const { registerMistralModel, setMistralRegionalModel, isMistralRegionalUrl } = require('../providers/mistralModels');
const { isEuResidencyUrl, registerEuServedModel, unregisterEuServedModel } = require('../providers/openaiModels');
const { getProviders, getAIConfig } = require('./providerConfig');
const { resolveModelId } = require('./modelNames');

const MODEL_CACHE_TTL = 60; // seconds
const _modelCache = new Map(); // in-memory fallback: providerId → { models: [], timestamp }

/**
 * Get models for a provider, using cache with 60s TTL.
 * @param {string} providerId - The provider ID to fetch models for
 * @param {boolean} [forceRefresh=false] - Force a cache refresh
 * @returns {Promise<Array<{id, name}>>} List of models
 */
async function getModelsForProvider(providerId, forceRefresh = false) {
    const now = Date.now();

    const providerData = await getProviders();
    const provider = (providerData.providers || []).find(p => p.id === providerId);

    // Mark this provider's models as self-hosted so modelCosts bills them at
    // €0. The decision keys off the provider's STORED type — never off the
    // adapter that happened to be resolved, which can come from a URL guess.
    // Getting that wrong in the other direction would zero out a paid endpoint.
    //
    // Applied on EVERY return path, cache hits included: the registry is
    // per-process while the model cache outlives the process (Redis), so a
    // freshly restarted server serving a warm cache would otherwise bill
    // self-hosted models at cloud rates until the cache expired.
    const isLocal = !!provider && isLocalProviderType(provider.type);
    const isScaleway = !!provider && provider.type === 'scaleway';
    const isMistral = !!provider && provider.type === 'mistral';
    const isMistralRegional = isMistral && isMistralRegionalUrl(provider.url);
    const isOpenAILike = !!provider && (provider.type === 'openai' || provider.type === 'azure');
    const isEu = isOpenAILike && isEuResidencyUrl(provider.url);
    const registerIfLocal = (models) => {
        if (isLocal) {
            for (const m of models) registerLocalModel(m?.id);
        }
        // Scaleway needs the same treatment for the opposite reason: its models
        // are open weights sold by other hosts too, so cost accounting must be
        // pinned to Scaleway's own tariff rather than a fuzzy price match.
        if (isScaleway) {
            for (const m of models) registerScalewayModel(m?.id);
        }
        // Mistral too: Ministral and Mistral Small are open weights sold by
        // other hosts, and the regional endpoints cost 1.1× — both facts live
        // on the provider record, which cost accounting never sees.
        if (isMistral) {
            for (const m of models) {
                registerMistralModel(m?.id);
                setMistralRegionalModel(m?.id, isMistralRegional);
            }
        }
        // Same again for EU regional processing — see getProviderForModel.
        if (isOpenAILike) {
            for (const m of models) {
                if (isEu) registerEuServedModel(m?.id);
                else unregisterEuServedModel(m?.id);
            }
        }
        return models;
    };

    // Try Redis first, then in-memory fallback
    if (!forceRefresh) {
        const r = getRedis();
        if (r) {
            try {
                const val = await r.get(`bf:mcache:${providerId}`);
                if (val) {
                    const models = JSON.parse(val);
                    _modelCache.set(providerId, { models, timestamp: now }); // keep in-memory in sync
                    return registerIfLocal(models);
                }
            } catch (_) { /* fall through */ }
        } else {
            const cached = _modelCache.get(providerId);
            if (cached && (now - cached.timestamp) < MODEL_CACHE_TTL * 1000) {
                return registerIfLocal(cached.models);
            }
        }
    }

    if (!provider) {
        log.warn(`[ModelCache] Provider ${providerId} not found`);
        return [];
    }

    const { getAdapter } = require('../providers');
    const adapter = getAdapter(provider.type, provider.url);
    const baseUrl = (provider.url || '').replace(/\/+$/, '');

    log.info(`[ModelCache] Fetching models for ${provider.name} (cache ${forceRefresh ? 'forced' : 'miss'})`);
    const models = await adapter.listModels(provider.apiKey, baseUrl, {
        project: provider.project,
        location: provider.location,
        serviceAccountKey: provider.serviceAccountKey,
    });

    if (models.length > 0) {
        _modelCache.set(providerId, { models, timestamp: now });
        const r = getRedis();
        if (r) {
            try { await r.set(`bf:mcache:${providerId}`, JSON.stringify(models), 'EX', MODEL_CACHE_TTL); } catch (_) { }
        }
        log.info(`[ModelCache] Cached ${models.length} models for ${provider.name}`);
    } else {
        log.info(`[ModelCache] Skipping cache for ${provider.name} (0 models)`);
    }
    return registerIfLocal(models);
}

/**
 * Invalidate model cache for a specific provider or all providers.
 * Call this when provider config changes (add/update/delete).
 */
function invalidateModelCache(providerId) {
    const r = getRedis();
    if (providerId) {
        _modelCache.delete(providerId);
        if (r) { r.del(`bf:mcache:${providerId}`).catch(() => { }); }
    } else {
        // Clear all model cache keys
        if (r) {
            r.keys('bf:mcache:*').then(keys => {
                if (keys.length) r.del(...keys).catch(() => { });
            }).catch(() => { });
        }
        _modelCache.clear();
    }
}

/**
 * Get all model IDs from the model cache (across all providers).
 * Returns objects with provider info to differentiate same-named models.
 */
async function getAllCachedModelIds() {
    const CONFIG_KEY = 'ai_providers';
    const providersRaw = await configStore.getConfig(CONFIG_KEY);
    const providers = providersRaw ? JSON.parse(providersRaw) : [];
    const providerMap = {};
    for (const p of providers) {
        providerMap[p.id] = { name: p.name, type: p.type };
    }

    const result = [];
    const seen = new Set();
    for (const [providerId, entry] of _modelCache) {
        const prov = providerMap[providerId] || { name: 'Unknown', type: 'unknown' };
        for (const m of entry.models) {
            const key = `${prov.name}::${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
                id: m.id,
                providerName: prov.name,
                providerType: prov.type,
            });
        }
    }
    return result;
}

// Get the provider config for a specific model
// This queries all providers to find which one owns the model
async function getProviderForModel(modelId) {
    // Resolve display names to model IDs
    modelId = resolveModelId(modelId) || modelId;
    const providerData = await getProviders();

    if (!providerData.providers || providerData.providers.length === 0) {
        return getAIConfig(); // Fallback to default config
    }

    // Try to find the model in each provider's model list
    for (const provider of providerData.providers) {
        try {
            const models = await getModelsForProvider(provider.id);
            const modelIds = models.map(m => m.id);

            // Check if this provider has the model
            if (modelIds.includes(modelId)) {
                log.info(`[AIAgent] Model ${modelId} found in provider: ${provider.name}`);
                // Remember that this model is served from the customer's own
                // hardware. modelCosts reads the registry to bill it at €0 —
                // without this it would hit the unknown-model upper bound and
                // a self-hosted Qwen would be charged at frontier rates.
                if (isLocalProviderType(provider.type)) registerLocalModel(modelId);
                // Same reasoning, opposite direction: Scaleway serves open
                // weights that other hosts also sell, so pin the price to
                // Scaleway's tariff instead of letting the fuzzy match pick a
                // host at random. Keyed on the STORED type, never the adapter.
                if (provider.type === 'scaleway') registerScalewayModel(modelId);
                // Mistral: its own price, plus the regional uplift when the
                // provider points at api.eu / api.us (and not when it moves back).
                // Azure: which model sits behind a custom-named deployment, for
                // pricing, the context window and the reasoning defaults.
                if (provider.type === 'azure') {
                    await require('../providers/azureDeployments').refreshAzureDeployments();
                }
                if (provider.type === 'mistral') {
                    registerMistralModel(modelId);
                    setMistralRegionalModel(modelId, isMistralRegionalUrl(provider.url));
                }
                // And once more for EU regional processing: an OpenAI provider
                // pointed at eu.api.openai.com is billed with a 10% uplift, and
                // cost accounting runs far from this record. Registering (and
                // UNregistering) on every resolution keeps the flag following
                // the provider when an admin switches the endpoint back.
                if (provider.type === 'openai' || provider.type === 'azure') {
                    if (isEuResidencyUrl(provider.url)) registerEuServedModel(modelId);
                    else unregisterEuServedModel(modelId);
                }
                return {
                    url: (provider.url || '').replace(/\/$/, ''),
                    model: modelId,
                    apiKey: provider.apiKey || '',
                    providerId: provider.id,
                    providerName: provider.name,
                    providerType: provider.type,
                    project: provider.project || null,
                    location: provider.location || null,
                    serviceAccountKey: provider.serviceAccountKey || null,
                };
            }
        } catch (e) {
            log.error(`[AIAgent] Failed to check models for ${provider.name}:`, e.message);
        }
    }

    // Model not found in any provider — fail instead of silently falling back
    log.error(`[AIAgent] Model ${modelId} not found in any configured provider`);
    throw new Error(`Model "${modelId}" not found in any configured provider. Check your model tier configuration.`);
}

module.exports = {
    MODEL_CACHE_TTL,
    getModelsForProvider,
    invalidateModelCache,
    getAllCachedModelIds,
    getProviderForModel,
};
