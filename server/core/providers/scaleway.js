// @typecheck
/**
 * Scaleway Generative APIs Provider Adapter
 *
 * Serverless, per-token endpoints for open-weight models, served from EU data
 * centres. The wire protocol is OpenAI's Chat Completions API, so almost
 * everything is inherited from BaseProvider — including the SSE parsing that
 * already handles both ways a reasoning model returns its chain of thought
 * (`reasoning_content` deltas and in-band `<think>` tags).
 *
 * What this adapter adds on top of the generic behaviour:
 *
 *  - `reasoning_effort`, coerced per model. Reasoning is ON by default on
 *    Scaleway and the accepted vocabulary differs per model (gpt-oss-120b has
 *    no `none`, GLM-5.2 speaks `high`/`max`), while an unsupported value is a
 *    400 that fails the whole call. Title generation asks every provider for
 *    `none`, so this cannot be passed through blindly.
 *  - `max_tokens` clamped to the model's serverless output cap (16k–32k, well
 *    under the context window) — over-asking is a 400, not a truncation.
 *  - `stream_options.include_usage`, so streamed turns report real token counts
 *    instead of being billed as zero.
 *  - Model discovery enriched from the catalog in ./scalewayModels.js, and each
 *    discovered id registered so cost accounting bills it at Scaleway's tariff
 *    rather than fuzzy-matching another host that sells the same open weights.
 *
 * Docs: https://www.scaleway.com/en/docs/generative-apis/
 */

const CatalogProvider = require('./catalogProvider');
const {
    describeScalewayModel,
    normalizeReasoningEffort,
    clampMaxTokens,
    registerScalewayModel,
} = require('./scalewayModels');

class ScalewayProvider extends CatalogProvider {
    constructor() {
        super('scaleway', {
            label: 'Scaleway',
            describe: describeScalewayModel,
            normalizeReasoningEffort,
            clampMaxTokens,
            register: registerScalewayModel,
            fetch: (url, init) => fetch(url, init),
        });
    }
}

module.exports = ScalewayProvider;
