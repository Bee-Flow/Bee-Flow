/**
 * Façade over core/llm/: provider configuration, model names, the model
 * cache and embeddings, re-exported under the names their callers use.
 *
 * New code requires the core/llm module it needs; this file exists so the
 * sixty-odd existing consumers did not all have to move at once.
 */

const providerConfig = require('./llm/providerConfig');
const { resolveModelId } = require('./llm/modelNames');
const modelCache = require('./llm/modelCache');
const { generateEmbedding } = require('./llm/embeddings');

module.exports = {
    getAIConfig: providerConfig.getAIConfig,
    saveAIConfig: providerConfig.saveAIConfig,
    getProviders: providerConfig.getProviders,
    addProvider: providerConfig.addProvider,
    updateProvider: providerConfig.updateProvider,
    deleteProvider: providerConfig.deleteProvider,
    setDefaultProvider: providerConfig.setDefaultProvider,
    ensureLocalProviders: providerConfig.ensureLocalProviders,
    ensureScalewayProvider: providerConfig.ensureScalewayProvider,
    ensureEuGptProvider: providerConfig.ensureEuGptProvider,
    PROVIDER_PRESETS: providerConfig.PROVIDER_PRESETS,
    resolveModelId,
    getProviderForModel: modelCache.getProviderForModel,
    getModelsForProvider: modelCache.getModelsForProvider,
    invalidateModelCache: modelCache.invalidateModelCache,
    getAllCachedModelIds: modelCache.getAllCachedModelIds,
    generateEmbedding,
};
