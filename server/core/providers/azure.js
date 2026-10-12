// @typecheck
/**
 * Azure OpenAI Provider Adapter (Azure AI Foundry, v1 GA API)
 *
 * Extends OpenAIProvider and inherits ALL of its request building: Responses
 * API, tool calling, streaming, reasoning (incl. encrypted-reasoning replay),
 * structured output, cache hints, content-part translation and the inlining of
 * our own stored images. Only what differs on Azure lives here.
 *
 * Transport — the v1 GA API (verified against Microsoft Learn, 2026-10-01):
 *   - `https://<resource>.openai.azure.com/openai/v1/` (also
 *     `*.services.ai.azure.com`), no `api-version` at all. Microsoft lists v1 as
 *     the only current data-plane version and recommends the plain `OpenAI`
 *     client with that baseURL; the key goes as a Bearer token.
 *   - NOT `AzureOpenAI`: openai-node's Azure class has no notion of v1. It
 *     always builds `<endpoint>/openai/...?api-version=<x>` and rewrites chat
 *     paths to `/deployments/<name>/`, i.e. the dated surface. Every install
 *     runs on v1; Bee Flow no longer stores an api-version at all.
 *   - The deployment name is sent as `model`.
 *
 * Deployments vs. models: on Azure the "model" in a request is a deployment
 * name the admin chose, e.g. `prod-chat`. Every capability decision (Responses
 * or not, reasoning effort vocabulary, temperature, cache parameters) is a
 * hard 400 when it is wrong, so the deployment list accepts `name=model`
 * (`prod-chat=gpt-5.6-sol, gpt-4.1`) and the capabilities are looked up on the
 * model while the wire still carries the deployment name.
 *
 * Other Azure differences:
 *   - store:false — BeeFlow keeps conversation history itself, so no
 *     server-side state (and no 30-day retention of customer prompts at
 *     Microsoft). The inherited methods then send full history, never chain,
 *     and replay the encrypted reasoning items.
 *   - Prompt caching: automatic from 1,024 tokens; `prompt_cache_key` is sent
 *     (inherited). Azure's default retention is in-memory (5-10 min idle), so
 *     the models that offer it get `prompt_cache_retention: '24h'` — same
 *     price, and a user who comes back after a coffee still hits the cache.
 *     `prompt_cache_options` / breakpoints are NOT sent: '30m' is the only TTL
 *     and already the default, and PTU-M deployments reject the field.
 *   - Tool descriptions are capped at 1,024 characters.
 *   - A deployment that does not support the Responses API (non-OpenAI models
 *     on Foundry, old snapshots) answers 400 "model not supported"; it is then
 *     served through Chat Completions, and remembered.
 */

const OpenAIProvider = require('./openai');
const { describeOpenAIModel } = require('./openaiModels');
const log = require('../../telemetry/log');
const { toV1BaseUrl } = require('../../utils/azureUrl');
const { parseDeployments, refreshAzureDeployments, azureModelFor } = require('./azureDeployments');

/** Azure's documented limit on a tool/function description. */
const MAX_TOOL_DESCRIPTION = 1024;

/**
 * Models on which Azure offers `prompt_cache_retention: '24h'` (Learn, "Prompt
 * caching", 2026-08-11). Exact catalog ids: a variant not on the list (a -mini,
 * a -nano) is not assumed to have it, because the parameter is a 400 where it
 * does not exist. gpt-5.6 and later use prompt_cache_options instead.
 */
const EXTENDED_RETENTION_MODELS = new Set([
    'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2',
    'gpt-5.1', 'gpt-5.1-chat', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
    'gpt-5', 'gpt-5-codex', 'gpt-4.1',
]);

/** 400 meaning "this deployment cannot do the Responses API" — not a bad parameter. */
function isResponsesUnsupported(err) {
    if (err?.status !== 400) return false;
    const msg = String(err?.error?.message || err?.message || '');
    if (err?.param || /parameter/i.test(msg)) return false;
    // Azure's own wording: code OperationNotSupported, "The responses operation
    // does not work with the specified model, gpt-35-turbo."
    if ((err?.code || err?.error?.code) === 'OperationNotSupported') return true;
    return /model/i.test(msg) && /not supported|unsupported|is not available|does not work with/i.test(msg);
}

/**
 * 400 meaning "this deployment does not accept prompt_cache_retention" (some
 * deployment types / regions do not offer the 24h cache). The parameter is only
 * an optimisation, so it is dropped for that model and the call retried.
 */
function isCacheRetentionRejected(err) {
    if (err?.status !== 400) return false;
    const msg = String(err?.error?.message || err?.message || '');
    return err?.param === 'prompt_cache_retention' || /prompt_cache_retention/i.test(msg);
}

class AzureProvider extends OpenAIProvider {
    constructor() {
        super();
        this.name = 'azure';
        this.responsesStore = false;
        /** Deployments that answered "model not supported" on the Responses API. */
        this._completionsOnly = new Set();
        /** Models whose deployments rejected prompt_cache_retention. */
        this._noCacheRetention = new Set();
    }

    // ─── Deployments ─────────────────────────────────────────────

    /** Re-read the admin's deployment list into the shared registry (azureDeployments.js). */
    async _loadDeployments() {
        return refreshAzureDeployments();
    }

    /**
     * The model id to look capabilities up on; the deployment name itself when
     * unmapped. Billing resolves through the same registry: usageStore.logUsage
     * logs and prices the call as this model (modelCosts.resolveBilledModel), and
     * a deployment that is NOT mapped (and not a model id we can price) is flagged
     * as an unknown model instead of being billed at a guessed rate.
     */
    _modelFor(deployment) {
        return azureModelFor(deployment);
    }

    /**
     * Same usage as OpenAI, stamped as Azure: the usage row then looks for the
     * Azure price card first (the deployment name is not a vendor model id).
     */
    _normalizeUsage(usage, meta) {
        const normalised = super._normalizeUsage(usage, meta);
        if (normalised) normalised.provider_type = 'azure';
        return normalised;
    }

    supportsReasoning(model) { return super.supportsReasoning(this._modelFor(model)); }
    supportsVision(model) { return super.supportsVision(this._modelFor(model)); }
    isRestrictedModel(model) { return super.isRestrictedModel(this._modelFor(model)); }

    /** prompt_cache_options: see the header — never sent on Azure. */
    supportsPromptCacheTtl() {
        return false;
    }

    shouldUseResponsesApi(model, options = {}) {
        if (this._completionsOnly.has(model)) return false;
        return super.shouldUseResponsesApi(this._modelFor(model), options);
    }

    // ─── SDK client (v1 GA) ──────────────────────────────────────

    /**
     * @param {string} apiKey
     * @param {object} [options]
     * @param {string} [options.baseUrl] - the resource endpoint from AI Settings → Providers
     * @param {string} [options.endpoint] - same, older spelling
     */
    createClient(apiKey, options = {}) {
        const endpoint = options.baseUrl || options.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
        if (!endpoint) {
            throw new Error('Azure AI requires an endpoint URL. Configure it in AI Settings → Providers.');
        }
        const OpenAI = /** @type {typeof import('openai').default} */ (/** @type {unknown} */ (require('openai')));
        return new OpenAI({ apiKey, baseURL: toV1BaseUrl(endpoint) });
    }

    // ─── Request building ────────────────────────────────────────
    // Capabilities are decided on the model; the wire carries the deployment.

    _buildResponsesParams(deployment, messages, options = {}) {
        const params = super._buildResponsesParams(this._modelFor(deployment), messages, options);
        params.model = deployment;
        // Stateless mode returns encrypted reasoning by default on current
        // models; older ones (before gpt-5.4) still need it asked for. Azure
        // documents the value as accepted for compatibility, so always ask.
        if (params.reasoning) params.include = ['reasoning.encrypted_content'];
        return params;
    }

    _buildCompletionsParams(deployment, messages, options = {}) {
        const params = super._buildCompletionsParams(this._modelFor(deployment), messages, options);
        params.model = deployment;
        // PDFs only go through Responses on Azure: Chat Completions `file` parts
        // are not reliably accepted there. A native PDF always travels next to
        // its extracted text (core/documents/nativePdf.js), so dropping the part
        // loses nothing — it matters on the first request of a deployment that
        // just fell back from Responses with the PDF already in the turn.
        params.messages = params.messages.map(m => (Array.isArray(m.content) && m.content.some(p => p?.type === 'file')
            ? { ...m, content: m.content.filter(p => p?.type !== 'file') }
            : m));
        return params;
    }

    _applyCacheHints(params, options = {}, model = null) {
        super._applyCacheHints(params, options, model);
        if (model && !this._noCacheRetention.has(model) && EXTENDED_RETENTION_MODELS.has(describeOpenAIModel(model).id)) {
            params.prompt_cache_retention = options.promptCacheRetention || '24h';
        }
    }

    /** Azure caps tool descriptions at 1,024 characters; longer ones fail the request. */
    _azureOptions(options) {
        if (!options.tools?.length) return options;
        const cap = (d) => (typeof d === 'string' && d.length > MAX_TOOL_DESCRIPTION
            ? `${d.slice(0, MAX_TOOL_DESCRIPTION - 1)}…`
            : d);
        const tools = options.tools.map(t => (t.function
            ? { ...t, function: { ...t.function, description: cap(t.function.description) } }
            : { ...t, description: cap(t.description) }));
        return { ...options, tools };
    }

    // ─── High-level API ──────────────────────────────────────────

    async chat(apiKey, baseUrl, model, messages, options = {}) {
        await this._loadDeployments();
        const opts = this._azureOptions(options);
        try {
            return await super.chat(apiKey, baseUrl, model, messages, opts);
        } catch (err) {
            if (!this._recoverable(model, opts, err)) throw err;
            return super.chat(apiKey, baseUrl, model, messages, opts);
        }
    }

    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        await this._loadDeployments();
        const opts = this._azureOptions(options);
        let emitted = false;
        const tracked = (type, data) => { emitted = true; onEvent(type, data); };
        try {
            return await super.stream(apiKey, baseUrl, model, messages, opts, tracked);
        } catch (err) {
            // Only before the first event: once text has gone out, a retry
            // would show the user the start of the answer twice.
            if (emitted || !this._recoverable(model, opts, err)) throw err;
            return super.stream(apiKey, baseUrl, model, messages, opts, onEvent);
        }
    }

    /** True when `err` is a known Azure capability 400 that was just worked around for `deployment`. */
    _recoverable(deployment, options, err) {
        if (isCacheRetentionRejected(err)) {
            const model = this._modelFor(deployment);
            if (this._noCacheRetention.has(model)) return false;
            this._noCacheRetention.add(model);
            log.warn(`[Azure] Deployment '${deployment}' rejects prompt_cache_retention — sending requests without it`);
            return true;
        }
        return this._fallBackToCompletions(deployment, options, err);
    }

    /**
     * Route this deployment to Chat Completions from now on, if `err` says it
     * cannot do the Responses API. A model that needs Responses for tools
     * (gpt-6) is not moved: Chat Completions would refuse it anyway.
     */
    _fallBackToCompletions(deployment, options, err) {
        if (this._completionsOnly.has(deployment) || !isResponsesUnsupported(err)) return false;
        // With the opt-out set, the base only still says "Responses" when it is required.
        if (super.shouldUseResponsesApi(this._modelFor(deployment), { ...options, useChatCompletions: true })) return false;
        this._completionsOnly.add(deployment);
        log.warn(`[Azure] Deployment '${deployment}' does not support the Responses API — using Chat Completions for it`);
        return true;
    }

    // ─── Models ──────────────────────────────────────────────────

    /** The admin-configured deployments; Azure has no deployment listing on the data plane. */
    async listModels(_apiKey, _baseUrl, _options = {}) {
        const list = await this._loadDeployments();
        if (!list?.length) {
            log.info('[Azure] No deployments configured');
            return [];
        }
        return list.map(d => ({
            id: d.deployment,
            name: d.model !== d.deployment ? `${d.deployment} (${d.model})` : d.deployment,
        }));
    }
}

module.exports = AzureProvider;
module.exports.toV1BaseUrl = toV1BaseUrl;
module.exports.parseDeployments = parseDeployments;
module.exports.isResponsesUnsupported = isResponsesUnsupported;
module.exports.isCacheRetentionRejected = isCacheRetentionRejected;
