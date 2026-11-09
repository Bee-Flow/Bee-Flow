// @typecheck strict
/**
 * IONOS AI Model Hub Provider Adapter
 *
 * German, EU-hosted, OpenAI-compatible inference (https://openai.inference.de-txl.ionos.com/v1,
 * Bearer token). Almost everything is inherited from BaseProvider. This adapter adds:
 *
 *  - `max_tokens` clamped where the catalog knows a cap.
 *  - `reasoning_effort` only for models with a known vocabulary (gpt-oss);
 *    anything else is dropped rather than risking a 400.
 *  - `stream_options.include_usage`, so streamed turns report real token counts.
 *  - Model discovery from `/v1/models`, enriched from ./ionosModels.js, with every
 *    discovered id registered so cost accounting bills IONOS's tariff.
 *    Embedding and rerank models are listed too (flags `embedding` / `rerank`).
 */

const CatalogProvider = require('./catalogProvider');
const {
    describeIonosModel,
    normalizeReasoningEffort,
    clampMaxTokens,
    registerIonosModel,
} = require('./ionosModels');
const { fetchConfiguredEndpoint } = require('../http/configuredEndpointFetch');

class IonosProvider extends CatalogProvider {
    constructor() {
        super('ionos', {
            label: 'IONOS',
            describe: describeIonosModel,
            normalizeReasoningEffort,
            clampMaxTokens,
            register: registerIonosModel,
            fetch: (url, init) => fetchConfiguredEndpoint(url, init),
        });
    }
}

module.exports = IonosProvider;
