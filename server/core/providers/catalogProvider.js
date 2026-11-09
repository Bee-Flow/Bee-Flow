// @typecheck strict
/**
 * Shared base for OpenAI-compatible hosts that serve open-weight models from a
 * shipped catalog (Scaleway, IONOS). Each host keeps its own catalog module;
 * this class holds the two behaviours that are identical across them:
 *
 *  - `buildRequestBody`: `max_tokens` clamped to the catalog's cap, a
 *    `reasoning_effort` only where the model's vocabulary accepts it, and
 *    `stream_options.include_usage` so streamed turns report real token counts.
 *  - `listModels`: the live `/v1/models` list, enriched from the catalog, with
 *    every served id registered so cost accounting bills the host's own tariff.
 *
 * The fetch is injected because the hosts reach `/v1/models` differently.
 */

const BaseProvider = require('./base');
const log = require('../../telemetry/log');

// Discovery must not hang a config screen. Chat calls use the caller's
// options.timeoutMs instead (see BaseProvider).
const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * @typedef {{
 *   label: string,
 *   describe: (id: string) => { id: string, name: string, vision?: boolean, reasoning?: boolean, [key: string]: unknown },
 *   normalizeReasoningEffort: (model: string, effort: string | undefined) => string | undefined | null,
 *   clampMaxTokens: (model: string, requested: unknown) => number | undefined,
 *   register: (id: string) => void,
 *   fetch: (url: string, init: { headers: Record<string, string>, signal: AbortSignal }) => Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>,
 * }} CatalogHooks
 */

class CatalogProvider extends BaseProvider {
    /**
     * @param {string} type
     * @param {CatalogHooks} hooks
     */
    constructor(type, hooks) {
        super(type);
        this.catalog = hooks;
    }

    // ─── Model capabilities ──────────────────────────────────────────

    /** @param {string} modelId */
    supportsVision(modelId) {
        return !!this.catalog.describe(modelId).vision;
    }

    /** @param {string} modelId */
    supportsReasoning(modelId) {
        return !!this.catalog.describe(modelId).reasoning;
    }

    // ─── Request Building ────────────────────────────────────────────

    /**
     * @param {string} model
     * @param {unknown[]} messages
     * @param {import('./base').BodyOptions & { reasoningEffort?: string }} [options]
     */
    buildRequestBody(model, messages, options = {}) {
        /** @type {{ model: string, messages: unknown, [key: string]: unknown }} */
        const body = super.buildRequestBody(model, messages, options);

        // Output caps can sit far below the context window, and asking for
        // more than the cap is rejected outright. No known cap: pass through.
        const maxTokens = this.catalog.clampMaxTokens(model, body.max_tokens);
        if (maxTokens === undefined) delete body.max_tokens;
        else body.max_tokens = maxTokens;

        // Only forward an effort the model actually accepts; anything else is
        // dropped, which leaves the model at its default effort rather than
        // failing the request. Never overrides an explicit extraBody value.
        if (body.reasoning_effort === undefined) {
            const effort = this.catalog.normalizeReasoningEffort(model, options.reasoningEffort);
            if (effort) body.reasoning_effort = effort;
        }

        // Ask for the trailing usage chunk. Without it a streamed turn ends
        // with no token counts and the call is logged — and billed — as zero.
        if (body.stream) {
            body.stream_options = { include_usage: true, ...(/** @type {Record<string, unknown>} */ (body.stream_options) || {}) };
        }

        return body;
    }

    // ─── Model discovery ─────────────────────────────────────────────

    /**
     * List the models this endpoint serves.
     *
     * The live `/v1/models` list is authoritative — these hosts add and retire
     * models faster than a shipped catalog can follow — and the catalog only
     * supplies the metadata the endpoint does not return. A failed call returns
     * nothing rather than the catalog: a provider whose key is invalid must not
     * appear to serve models, or model resolution would route chats to it and
     * every one of them would 401.
     * @param {string | undefined} [apiKey]
     * @param {string | null | undefined} [baseUrl]
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
                const res = await this.catalog.fetch(url, { headers, signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = /** @type {typeof data} */ (await res.json());
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            log.warn(`[${this.catalog.label}] /v1/models failed: ${/** @type {Error} */ (e).message}`);
            return [];
        }

        const models = (data?.data || [])
            .map(m => m?.id)
            .filter(/** @type {(id: string | undefined) => id is string} */ (id) => typeof id === 'string' && !!id)
            .map(id => this.catalog.describe(id));

        // Pin cost accounting to the host's own tariff for everything this
        // endpoint serves. Every model here is open-weight and also sold
        // elsewhere, so without this the fuzzy price match could bill a call at
        // a different host's rate.
        for (const m of models) this.catalog.register(m.id);

        return models;
    }
}

module.exports = CatalogProvider;
