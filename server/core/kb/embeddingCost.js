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

/** @param {number} totalTokensEstimate */
function trackEmbeddingTokens(totalTokensEstimate) {
    try {
        const { computeEmbeddingCost } = require('../llm/azureServiceCosts');
        const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
        const cost = computeEmbeddingCost(totalTokensEstimate);
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
 */
function trackEmbeddingCost(texts) {
    trackEmbeddingTokens((texts || []).reduce((sum, t) => sum + estimateTokens(t), 0));
}

module.exports = { trackEmbeddingTokens, trackEmbeddingCost };
