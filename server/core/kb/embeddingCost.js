// @typecheck strict
/**
 * Cost logging for the embeddings of the local KB ingest. A leaf: the local
 * ingest and the embedding migration both record cost, and neither may require
 * the other (import cycle). What it prices with is required at the call, for
 * the same reason.
 *
 * PRICED BY WHAT DID THE WORK. The caller passes the embedding target that
 * answered (core/embed/resolveTarget.js; dispatchEmbedTexts hands it back):
 *   - no target (the legacy `azure_openai_embedding_*` path), or an Azure
 *     provider: Azure's embedding rate (core/llm/azureServiceCosts), as before.
 *   - a self-hosted runtime, decided on the STORED provider type: zero.
 *   - any other provider: core/llm/modelCosts with that provider type. A
 *     Scaleway or IONOS model is first registered as served by that provider
 *     (what core/llm/modelCache does for configured models), so it is priced
 *     through its exact `scaleway/<vendor>/<id>` or `ionos/<org>/<id>` key, or
 *     the provider's list price, never another host's rate for the same open
 *     weights.
 * The usage column is USD (the Azure rates it was made for): a card in another
 * currency (Scaleway and IONOS quote EUR) is converted with the configured FX
 * rate, and the row's metadata says what priced it.
 */

'use strict';

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { estimateTokens } = require('./chunking');

/** @typedef {{ providerType?: string | null, modelId?: string | null }} EmbedTarget */

/**
 * @param {number} tokens
 * @param {number} cost  USD
 * @param {Record<string, unknown> | null} metadata
 * @returns {Promise<void>}
 */
function record(tokens, cost, metadata) {
    const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
    const written = azureServiceUsageStore.logAzureServiceUsage({
        service_type: 'embedding',
        tokens,
        estimated_cost: cost,
        source: 'kb_upload',
        ...(metadata ? { metadata } : {}),
    }).catch((/** @type {unknown} */ e) => bestEffort('core/kb/localIngest:_trackEmbeddingCost', e));
    if (cost > 0) log.info(`[LocalKBIngest] 💰 Embedding cost: $${cost.toFixed(6)} (~${tokens} tokens)`);
    return written;
}

/**
 * Pin a model to the tariff of the provider that serves it, by its stored type.
 * @param {string} providerType
 * @param {string} modelId
 */
function registerServed(providerType, modelId) {
    if (providerType === 'scaleway') require('../providers/scalewayModels').registerScalewayModel(modelId);
    else if (providerType === 'ionos') require('../providers/ionosModels').registerIonosModel(modelId);
}

/**
 * What `tokens` embedding tokens cost on this provider, in USD, and what priced it.
 * @param {number} tokens
 * @param {string} providerType
 * @param {string} modelId
 * @returns {Promise<{ cost: number, metadata: Record<string, unknown> }>}
 */
async function providerCost(tokens, providerType, modelId) {
    const facts = { provider_type: providerType, model: modelId };
    if (require('../providers/localModels').isLocalProviderType(providerType)) {
        return { cost: 0, metadata: { ...facts, cost_basis: 'local' } };
    }
    registerServed(providerType, modelId);
    const rated = require('../llm/modelCosts').rateUsage({
        model: modelId, provider_type: providerType, prompt_tokens: tokens, completion_tokens: 0,
    });
    let cost = rated.cost;
    if (cost > 0 && rated.currency !== 'USD') {
        const perUsd = await require('../text/currency').getUsdToCurrencyRate(rated.currency);
        cost = perUsd > 0 ? cost / perUsd : cost;
    }
    return {
        cost,
        metadata: { ...facts, cost_basis: rated.cost_basis, price_source: rated.source, price_currency: rated.currency, price_cost: rated.cost },
    };
}

/**
 * Record the cost of embedding `totalTokensEstimate` tokens. Never throws; the
 * returned promise settles once the row is written (callers need not wait).
 * @param {number} totalTokensEstimate
 * @param {EmbedTarget | null} [target]  the embedding target that did the work; none is the legacy Azure path
 * @returns {Promise<void>}
 */
function trackEmbeddingTokens(totalTokensEstimate, target = null) {
    const providerType = target?.providerType || null;
    const modelId = target?.modelId || null;
    if (providerType && modelId && providerType !== 'azure') {
        return providerCost(totalTokensEstimate, providerType, modelId)
            .then(({ cost, metadata }) => record(totalTokensEstimate, cost, metadata))
            .catch((/** @type {unknown} */ e) => { log.warn('could not record embedding usage', e); });
    }
    try {
        const { computeEmbeddingCost } = require('../llm/azureServiceCosts');
        return record(totalTokensEstimate, computeEmbeddingCost(totalTokensEstimate), null);
    } catch (_) {
        log.warn('could not record embedding usage', _);
        return Promise.resolve();
    }
}

/**
 * Cost logging for embedding these texts, as an ingest would log it.
 * @param {string[]} texts
 * @param {EmbedTarget | null} [target]  as for trackEmbeddingTokens
 */
function trackEmbeddingCost(texts, target = null) {
    return trackEmbeddingTokens((texts || []).reduce((sum, t) => sum + estimateTokens(t), 0), target);
}

module.exports = { trackEmbeddingTokens, trackEmbeddingCost };
