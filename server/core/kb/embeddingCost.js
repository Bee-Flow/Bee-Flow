// @typecheck strict
/**
 * Cost logging for the embeddings of the local KB ingest. A leaf: the local
 * ingest and the embedding migration both record cost, and neither may require
 * the other (import cycle).
 */

'use strict';

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { estimateTokens } = require('./chunking');

/**
 * Who made the embeddings: the `source` and `model` dispatchEmbedTexts returns,
 * and the provider type of the configured target.
 * @typedef {{ source?: string | null, model?: string | null, providerType?: string | null }} EmbedOrigin
 */

/**
 * The cost of `tokens` embedding tokens at the rate of the provider that made
 * them (core/llm/modelCosts: exact scaleway/ and ionos/ keys, zero for a
 * self-hosted runtime). The Azure embedding rate stays for the legacy
 * azure_openai_embedding_* path, and for a caller that does not say who embedded.
 * @param {number} tokens
 * @param {EmbedOrigin} [origin]
 */
function embeddingCostFor(tokens, origin = {}) {
    const { source, model, providerType } = origin;
    if (source === 'azure' || !model || !providerType) {
        return require('../llm/azureServiceCosts').computeEmbeddingCost(tokens);
    }
    if (require('../providers/localModels').isLocalProviderType(providerType)) return 0;
    // What the adapters do on a chat call: pin the model to its host's own tariff.
    if (providerType === 'scaleway') require('../providers/scalewayModels').registerScalewayModel(model);
    if (providerType === 'ionos') require('../providers/ionosModels').registerIonosModel(model);
    const { computeCost, resolveBilledModel } = require('../llm/modelCosts');
    return computeCost(resolveBilledModel(model, providerType), tokens, 0, 0, 0, null, { provider_type: providerType });
}

/**
 * @param {number} totalTokensEstimate
 * @param {EmbedOrigin} [origin]
 */
function trackEmbeddingTokens(totalTokensEstimate, origin) {
    try {
        const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
        const cost = embeddingCostFor(totalTokensEstimate, origin);
        azureServiceUsageStore.logAzureServiceUsage({
            service_type: 'embedding',
            tokens: totalTokensEstimate,
            estimated_cost: cost,
            source: 'kb_upload',
        }).catch((/** @type {unknown} */ e) => bestEffort('core/kb/localIngest:_trackEmbeddingCost', e));
        if (cost > 0) log.info(`[LocalKBIngest] 💰 Embedding cost: $${cost.toFixed(6)} (~${totalTokensEstimate} tokens)`);
    } catch (_) { log.warn('could not record embedding usage', _); }
}

/**
 * Cost logging for embedding these texts, as an ingest would log it.
 * @param {string[]} texts
 * @param {EmbedOrigin} [origin]
 */
function trackEmbeddingCost(texts, origin) {
    trackEmbeddingTokens((texts || []).reduce((sum, t) => sum + estimateTokens(t), 0), origin);
}

module.exports = { embeddingCostFor, trackEmbeddingTokens, trackEmbeddingCost };
