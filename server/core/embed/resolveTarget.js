// @typecheck strict
/**
 * Embedding-target resolver — picks the right provider/model for an
 * embedding call based on global AI config (`ai.embeddingProviderId` +
 * `ai.embeddingModel`). Mirrors the logic in webSearchInferenceResolver
 * but exposed as a reusable helper so memoryStore, KB ingest, and any
 * future embedding caller can dispatch the same way.
 *
 * Returned shape (or null when nothing is configured):
 *   { providerId, providerName, providerType, modelId, endpoint, apiKey, dimensions }
 *
 * `dimensions` is the length each returned vector is shortened to
 * (reduceVector), or null for the model's own length. It is the decision stored when the model was
 * chosen (`ai.embeddingOutput`, see ./outputDimensions.mts), never derived
 * from the catalog here: a configuration whose vectors were stored at the
 * model's own length must keep getting that length.
 */

const { storedDimensions, reduceVector } = require('./outputDimensions.mts');

async function resolveEmbedTarget() {
    const configStore = require('../../stores/configStore');
    return embedTargetFrom(await configStore.getConfig('ai'));
}

/**
 * The target for a stored `ai` config record (pure; resolveEmbedTarget reads the record).
 * @param {Record<string, any> | null | undefined} stored
 */
function embedTargetFrom(stored) {
    const ai = stored || {};
    const providerId = ai.embeddingProviderId;
    const modelId = ai.embeddingModel;
    if (!providerId || !modelId) return null;

    const providers = ai.providers || [];
    const provider = providers.find((/** @type {{ id: string }} */ p) => p.id === providerId);
    if (!provider) return null;

    return {
        providerId,
        providerName: provider.name || providerId,
        providerType: provider.type || null,
        modelId,
        endpoint: provider.url || null,
        apiKey: provider.apiKey || null,
        dimensions: storedDimensions(ai.embeddingOutput, providerId, modelId),
    };
}

// reduceVector: for stores/memoryEmbedding.js, which reaches core/embed only through this module.
module.exports = { resolveEmbedTarget, embedTargetFrom, reduceVector };
