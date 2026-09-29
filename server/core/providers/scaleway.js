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

const BaseProvider = require('./base');
const {
    describeScalewayModel,
    normalizeReasoningEffort,
    clampMaxTokens,
    registerScalewayModel,
} = require('./scalewayModels');
const log = require('../../telemetry/log');

// Discovery must not hang a config screen. Chat calls use the caller's
// options.timeoutMs instead (see BaseProvider).
const DISCOVERY_TIMEOUT_MS = 8000;

class ScalewayProvider extends BaseProvider {
    constructor() {
        super('scaleway');
    }

    // ─── Model capabilities ──────────────────────────────────────────

    supportsVision(modelId) {
        return !!describeScalewayModel(modelId).vision;
    }

    supportsReasoning(modelId) {
        return !!describeScalewayModel(modelId).reasoning;
    }

    // ─── Request Building ────────────────────────────────────────────

    buildRequestBody(model, messages, options = {}) {
        const body = super.buildRequestBody(model, messages, options);

        // Serverless output caps are far below the context window, and asking
        // for more than the cap is rejected outright.
        const maxTokens = clampMaxTokens(model, body.max_tokens);
        if (maxTokens === undefined) delete body.max_tokens;
        else body.max_tokens = maxTokens;

        // Only forward an effort the model actually accepts; anything else is
        // dropped, which leaves the model at its default effort rather than
        // failing the request. Never overrides an explicit extraBody value.
        if (body.reasoning_effort === undefined) {
            const effort = normalizeReasoningEffort(model, options.reasoningEffort);
            if (effort) body.reasoning_effort = effort;
        }

        // Ask for the trailing usage chunk. Without it a streamed turn ends
        // with no token counts and the call is logged — and billed — as zero.
        if (body.stream) {
            body.stream_options = { include_usage: true, ...(body.stream_options || {}) };
        }

        return body;
    }

    // ─── Model discovery ─────────────────────────────────────────────

    /**
     * List the models this endpoint serves.
     *
     * The live `/v1/models` list is authoritative — Scaleway adds and retires
     * serverless models faster than a shipped catalog can follow — and the
     * catalog only supplies the metadata the endpoint does not return. A failed
     * call returns nothing rather than the catalog: a provider whose key is
     * invalid must not appear to serve fifteen models, or model resolution
     * would route chats to it and every one of them would 401.
     */
    async listModels(apiKey, baseUrl) {
        const headers = this.getHeaders(apiKey);
        const root = (baseUrl || '').replace(/\/+$/, '');
        const url = `${root.endsWith('/v1') ? root : `${root}/v1`}/models`;

        /** @type {{ data?: Array<{ id?: string }> } | undefined} */
        let data;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
            try {
                const res = await fetch(url, { headers, signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            log.warn(`[Scaleway] /v1/models failed: ${e.message}`);
            return [];
        }

        const models = (data?.data || [])
            .map(m => m?.id)
            .filter(id => typeof id === 'string' && id)
            .map(id => describeScalewayModel(id));

        // Pin cost accounting to Scaleway's own tariff for everything this
        // endpoint serves. Every model here is open-weight and also sold
        // elsewhere, so without this the fuzzy price match could bill a call at
        // a different host's rate.
        for (const m of models) registerScalewayModel(m.id);

        return models;
    }
}

module.exports = ScalewayProvider;
