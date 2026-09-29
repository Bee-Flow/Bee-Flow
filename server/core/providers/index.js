// @typecheck
/**
 * Provider Factory
 *
 * Returns the correct provider adapter based on provider type or URL.
 *
 * To add a new provider:
 * 1. Create a new adapter file (e.g., anthropic.js)
 * 2. Instantiate it below
 * 3. Add to PROVIDER_MAP and optionally URL_PATTERNS
 *
 * Self-hosted runtimes (Ollama, vLLM, llama.cpp, …) are all instances of the
 * single LocalProvider adapter, one per flavour — see ./local.js. To support
 * another one, add it to LOCAL_RUNTIMES in ./localModels.js; it is picked up
 * here automatically.
 */

const OpenAIProvider = require('./openai');
const MistralProvider = require('./mistral');
const ClaudeProvider = require('./claude');
const GoogleProvider = require('./google');
const GoogleVertexProvider = require('./googleVertex');
const AzureProvider = require('./azure');
const ScalewayProvider = require('./scaleway');
const EuGptProvider = require('./eugpt');
const LocalProvider = require('./local');
const BaseProvider = require('./base');
const { LOCAL_PROVIDER_TYPES, LOCAL_RUNTIMES, isLocalProviderType, isPrivateHostUrl } = require('./localModels');
// Straight from the capture module, not through outboundProbe: tests replace
// outboundProbe with a two-function stub, and a model call must still run.
const { outsideProbe } = require('../http/egressCapture');

// A model call is not an egress row (owner decision): the Privacy Shield
// ledger records what TOOLS and automations send, and a sub-agent, a swarm
// worker or a browse agent calls its model from inside a tool's capture
// context. So the adapters' model entry points leave that context. Filtered
// per CALL, deliberately not per host: OCR, Voxtral and the transcription
// tools talk to the same AI hosts and ARE egress. Wrapped on the prototypes,
// so an adapter constructed anywhere gets it, and a subclass calling
// `super.chat()` just leaves an already empty context once more.
const MODEL_CALLS = ['chat', 'stream', 'listModels'];
for (const Provider of [BaseProvider, OpenAIProvider, MistralProvider, ClaudeProvider, GoogleProvider,
    GoogleVertexProvider, AzureProvider, ScalewayProvider, EuGptProvider, LocalProvider]) {
    for (const method of MODEL_CALLS) {
        const own = Object.prototype.hasOwnProperty.call(Provider.prototype, method) ? Provider.prototype[method] : null;
        if (typeof own !== 'function' || own.outsideProbe === true) continue;
        const wrapped = function modelCallOutsideProbe(...args) {
            return outsideProbe(() => own.apply(this, args));
        };
        wrapped.outsideProbe = true;
        Provider.prototype[method] = wrapped;
    }
}

// Singleton instances
const openaiAdapter = new OpenAIProvider();
const mistralAdapter = new MistralProvider();
const claudeAdapter = new ClaudeProvider();
const googleAdapter = new GoogleProvider();
const googleVertexAdapter = new GoogleVertexProvider();
const azureAdapter = new AzureProvider();
const scalewayAdapter = new ScalewayProvider();
const eugptAdapter = new EuGptProvider();
const baseAdapter = new BaseProvider('generic');

// One LocalProvider per self-hosted runtime flavour.
const localAdapters = Object.fromEntries(
    LOCAL_PROVIDER_TYPES.map(flavor => [flavor, new LocalProvider(flavor)])
);

// Map provider type strings to adapter instances
const PROVIDER_MAP = {
    'openai': openaiAdapter,
    'mistral': mistralAdapter,
    'claude': claudeAdapter,
    'google': googleAdapter,
    'google-vertex': googleVertexAdapter,
    'azure': azureAdapter,
    'scaleway': scalewayAdapter,
    'eugpt': eugptAdapter,
    ...localAdapters,
    // 'local' is the umbrella type older configs / imports may carry; it maps
    // to the generic OpenAI-compatible behaviour, which is correct for every
    // runtime except Ollama's richer discovery.
    'local': localAdapters['openai-compatible'],
};

// URL patterns to auto-detect provider when type is unknown
const URL_PATTERNS = [
    { pattern: /openai\.com/i, adapter: openaiAdapter },
    { pattern: /mistral\.ai/i, adapter: mistralAdapter },
    { pattern: /anthropic\.com/i, adapter: claudeAdapter },
    { pattern: /generativelanguage\.googleapis\.com/i, adapter: googleAdapter },
    { pattern: /aiplatform\.googleapis\.com/i, adapter: googleVertexAdapter },
    { pattern: /\.openai\.azure\.com/i, adapter: azureAdapter },
    { pattern: /cognitiveservices\.azure\.com/i, adapter: azureAdapter },
    // Serverless Generative APIs and the per-project variant
    // (api.scaleway.ai/<project-id>/v1) share one host.
    { pattern: /api\.scaleway\.ai/i, adapter: scalewayAdapter },
    // chat.eugpt.ai (documented) and api.eugpt.ai serve the same backend.
    { pattern: /(^|\/\/|\.)eugpt\.ai(:|\/|$)/i, adapter: eugptAdapter },
];

// Self-hosted runtimes, keyed on the port each one listens on by default. Only
// consulted when a provider has no stored type, and only for an address on the
// operator's own network (see isPrivateHostUrl) — a port number is not on its
// own evidence of anything. `https://llm.company.com:8000/v1` is far more
// likely to be a LiteLLM proxy fronting a paid API than a vLLM box, and
// treating it as self-hosted would bill real spend at €0.
const LOCAL_URL_PATTERNS = [
    { pattern: /:11434(\/|$)|(^|\/\/)ollama(:|\/|$)/i, adapter: localAdapters.ollama },
    { pattern: /:1234(\/|$)/, adapter: localAdapters.lmstudio },
    { pattern: /:30000(\/|$)/, adapter: localAdapters.sglang },
    { pattern: /:1337(\/|$)/, adapter: localAdapters.jan },
    { pattern: /:5001(\/|$)/, adapter: localAdapters.koboldcpp },
    { pattern: /:8000(\/|$)|(^|\/\/)vllm(:|\/|$)/i, adapter: localAdapters.vllm },
    { pattern: /:8080(\/|$)|(^|\/\/)(llamacpp|llama-server|localai)(:|\/|$)/i, adapter: localAdapters.llamacpp },
];

/**
 * Get the correct provider adapter.
 *
 * @param {string} [providerType] - Provider type ('openai', 'mistral', 'claude', etc.)
 * @param {string} [url] - Provider URL (used for auto-detection if type is unknown)
 * @returns {BaseProvider} Provider adapter instance
 */
function getAdapter(providerType, url) {
    // Try by explicit type first
    if (providerType && PROVIDER_MAP[providerType]) {
        return PROVIDER_MAP[providerType];
    }

    // Auto-detect from URL
    if (url) {
        for (const { pattern, adapter } of URL_PATTERNS) {
            if (pattern.test(url)) {
                return adapter;
            }
        }
        if (isPrivateHostUrl(url)) {
            for (const { pattern, adapter } of LOCAL_URL_PATTERNS) {
                if (pattern.test(url)) {
                    return adapter;
                }
            }
        }
    }

    // Fallback to base adapter (generic OpenAI-compatible)
    return baseAdapter;
}

module.exports = {
    getAdapter,
    openaiAdapter,
    mistralAdapter,
    claudeAdapter,
    googleAdapter,
    googleVertexAdapter,
    azureAdapter,
    scalewayAdapter,
    eugptAdapter,
    baseAdapter,
    localAdapters,
    LOCAL_PROVIDER_TYPES,
    LOCAL_RUNTIMES,
    isLocalProviderType,
    // Re-export for convenience
    OpenAIProvider,
    MistralProvider,
    ClaudeProvider,
    GoogleProvider,
    GoogleVertexProvider,
    AzureProvider,
    ScalewayProvider,
    EuGptProvider,
    LocalProvider,
    BaseProvider,
};
