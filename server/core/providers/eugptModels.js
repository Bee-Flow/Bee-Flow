// @typecheck
/**
 * EU GPT — the one model its API serves.
 *
 * EU GPT (eugpt.ai) routes every request itself: the `model` field is accepted
 * for OpenAI-SDK compatibility and ignored, and "auto" is the only meaningful
 * value. The concrete model it picked (gpt-oss-120b, …) is reported back on the
 * response and changes without notice, so there is nothing to list and nothing
 * to price per model. What the tier picker sees is therefore a single entry.
 *
 * The id is `eugpt-auto` rather than the bare `auto` the wire wants: model
 * resolution maps an id to the provider that lists it, and `auto` is exactly
 * the kind of id another router-style provider would list too. The adapter
 * translates it back to `auto` on every request.
 *
 * Dependency-free on purpose, like the other *Models.js catalogs, so
 * providerConfig can read the base URL without loading an adapter.
 *
 * Docs: https://eugpt.ai/api
 */

// The documented base URL (API reference, SDK guide). api.eugpt.ai serves the
// same backend; either host is recognised by the URL pattern in ./index.js.
const EUGPT_BASE_URL = 'https://chat.eugpt.ai/v1';

const EUGPT_MODEL_ID = 'eugpt-auto';

// What goes on the wire. Anything else is ignored at best and, per the error
// reference, a 400 ("model references an unknown id") at worst.
const EUGPT_WIRE_MODEL = 'auto';

/**
 * Tier-picker metadata for the routed model. `eugpt: true` is the flag the
 * frontend admits server-described models on (see agent-hub modelMeta.js).
 */
function describeEuGptModel(modelId = EUGPT_MODEL_ID) {
    return {
        id: modelId,
        name: 'EU GPT (auto)',
        cat: 'Generalist',
        desc: 'Open-weight models on EU infrastructure, routed per request by EU GPT',
        context: null,
        maxOutput: null,
        // The router picks reasoning models for hard prompts, but the API
        // exposes no reasoning stream and no effort control, so there is
        // nothing for a caller to switch on.
        reasoning: false,
        // Input parts are text and uploaded-file references only.
        vision: false,
        // No client-defined tools: the API runs its own four (web_search,
        // web_fetch, calculator, current_datetime) server-side.
        tools: false,
        embedding: false,
        audio: false,
        status: 'preview',
        eugpt: true,
    };
}

module.exports = {
    EUGPT_BASE_URL,
    EUGPT_MODEL_ID,
    EUGPT_WIRE_MODEL,
    describeEuGptModel,
};
