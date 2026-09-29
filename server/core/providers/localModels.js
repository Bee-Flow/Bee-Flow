// @typecheck
/**
 * Open-weight model knowledge + the local-model registry.
 *
 * Two jobs, deliberately in one dependency-free module so it can be required
 * from anywhere (adapters, cost accounting, tier resolution) without cycles:
 *
 *  1. FAMILY METADATA — a self-hosted runtime hands us nothing but a bare id
 *     (`qwen3:30b`, `Qwen/Qwen3-30B-A3B-Instruct`, `DeepSeek-R1-Distill-32B.gguf`).
 *     `describeLocalModel()` turns that into a display name, a category, and
 *     capability flags (reasoning / vision / tools / embedding) so local models
 *     land in the tier picker looking like every other model instead of a raw
 *     tag string.
 *
 *  2. LOCAL-MODEL REGISTRY — which model ids currently belong to a locally
 *     hosted provider. Cost accounting reads this: a model served from the
 *     customer's own GPU costs nothing per token, and MUST NOT fall through to
 *     modelCosts' "unknown model → upper-bound rates" safety net (which would
 *     bill a self-hosted Qwen at Opus rates). The registry is populated by the
 *     local adapter on listModels() and by getProviderForModel() on every
 *     resolution, so it is always warm before a cost is computed for a call.
 */

// ─── Runtime flavours ────────────────────────────────────────────────────────
// Every entry is an OpenAI-compatible server; `nativeApi` marks the ones that
// also expose a richer proprietary API worth preferring for model discovery.
const LOCAL_RUNTIMES = {
    ollama: {
        label: 'Ollama',
        defaultUrl: 'http://localhost:11434',
        defaultPort: 11434,
        nativeApi: 'ollama',
        needsApiKey: false,
        canPull: true,
        docsUrl: 'https://docs.ollama.com',
        description: 'Easiest local runtime. One-command model downloads, runs on CPU or GPU.',
    },
    vllm: {
        label: 'vLLM',
        defaultUrl: 'http://localhost:8000/v1',
        defaultPort: 8000,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/',
        description: 'High-throughput GPU serving for production. Serves one model per process.',
    },
    llamacpp: {
        label: 'llama.cpp',
        defaultUrl: 'http://localhost:8080/v1',
        defaultPort: 8080,
        nativeApi: 'llamacpp',
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
        description: 'llama-server: GGUF models on CPU, Metal, CUDA or Vulkan. Very light.',
    },
    lmstudio: {
        label: 'LM Studio',
        defaultUrl: 'http://localhost:1234/v1',
        defaultPort: 1234,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://lmstudio.ai/docs/developer',
        description: 'Desktop app with a built-in OpenAI-compatible server.',
    },
    sglang: {
        label: 'SGLang',
        defaultUrl: 'http://localhost:30000/v1',
        defaultPort: 30000,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://docs.sglang.ai/',
        description: 'GPU serving runtime focused on structured output and high throughput.',
    },
    localai: {
        label: 'LocalAI',
        defaultUrl: 'http://localhost:8080/v1',
        defaultPort: 8080,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://localai.io/',
        description: 'Drop-in OpenAI replacement covering chat, embeddings, image and audio.',
    },
    tgi: {
        label: 'Text Generation Inference',
        defaultUrl: 'http://localhost:8080/v1',
        defaultPort: 8080,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://huggingface.co/docs/text-generation-inference',
        description: "Hugging Face's production inference server.",
    },
    jan: {
        label: 'Jan',
        defaultUrl: 'http://localhost:1337/v1',
        defaultPort: 1337,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://jan.ai/docs',
        description: 'Open-source desktop assistant with a local API server.',
    },
    koboldcpp: {
        label: 'KoboldCpp',
        defaultUrl: 'http://localhost:5001/v1',
        defaultPort: 5001,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: 'https://github.com/LostRuins/koboldcpp/wiki',
        description: 'Single-binary GGUF runtime with an OpenAI-compatible endpoint.',
    },
    'openai-compatible': {
        label: 'OpenAI-compatible endpoint',
        defaultUrl: 'http://localhost:8000/v1',
        defaultPort: null,
        nativeApi: null,
        needsApiKey: false,
        canPull: false,
        docsUrl: null,
        description: 'Any other server that speaks the OpenAI /v1 API (TensorRT-LLM, Ray Serve, a gateway…).',
    },
};

const LOCAL_PROVIDER_TYPES = Object.freeze(Object.keys(LOCAL_RUNTIMES));
const LOCAL_TYPE_SET = new Set(LOCAL_PROVIDER_TYPES);

/** True when a provider type is one of the self-hosted / OpenAI-compatible runtimes. */
function isLocalProviderType(type) {
    return !!type && LOCAL_TYPE_SET.has(type);
}

/**
 * Does this URL point somewhere that could only be the operator's own network?
 *
 * Used ONLY to decide whether a provider with no stored type may be guessed to
 * be a local runtime from its port. Port numbers alone are not evidence: a
 * LiteLLM proxy fronting OpenAI at `https://llm.company.com:8000/v1` uses the
 * same port as vLLM, and mistaking it for self-hosted would bill real API
 * spend at €0. A private address is evidence; a public hostname is not.
 *
 * Deliberately conservative — a false negative just means the generic
 * OpenAI-compatible adapter is used, which is the previous behaviour.
 */
function isPrivateHostUrl(url) {
    let host;
    try {
        host = new URL(String(url)).hostname.toLowerCase();
    } catch (_) {
        return false;
    }
    if (host === 'localhost' || host === 'host.docker.internal') return true;
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return true;
    // IPv6 loopback, with or without brackets (URL.hostname keeps them).
    if (host === '::1' || host === '[::1]') return true;
    // RFC1918 + loopback + link-local IPv4.
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    // A single-label hostname is a container/service name (`ollama`, `vllm`) or
    // an intranet short name — never a public endpoint.
    if (!host.includes('.') && !host.includes(':')) return true;
    return false;
}

// ─── Open-weight family metadata ─────────────────────────────────────────────
// Matched against a NORMALISED id (see normalizeLocalModelId): lowercased, with
// the org prefix, quantisation tag and file extension stripped. Order matters —
// the first matching pattern wins, so put the specific ones first.
//
// `cat` uses the same vocabulary as the frontend model catalogue
// (Generalist / Reasoning / Coding / Vision / Embedding) so local models sort
// into the existing tier-picker groups.
//
// `thinkingMinTemperature` is the lowest sampling temperature a family
// documents for its thinking mode. Qwen3 and DeepSeek-R1 both publish ≥ 0.6
// ("greedy decoding … endless repetitions"), GLM-4.5+ and NVIDIA's Nemotron
// reasoning cards the same number; the local adapter lifts a lower caller
// temperature to it while thinking is on.
// It used to be one constant for every model. Gemma 4 publishes no such
// floor and, measured on the demo box, does not loop at the 0.0-0.2 the
// builder profiles send for stable tool-call JSON — so it has none, and a
// family without an entry keeps the caller's temperature untouched.
const THINKING_FLOOR_QWEN_DEEPSEEK = 0.6;
const FAMILY_PATTERNS = [
    // ── Reasoning-first families ─────────────────────────────────────────────
    { re: /^deepseek-?r1|deepseek.*\br1\b/, name: 'DeepSeek-R1', cat: 'Reasoning', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^deepseek-?v3|deepseek-?chat/, name: 'DeepSeek-V3', cat: 'Generalist', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^qwq/, name: 'QwQ', cat: 'Reasoning', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^qwen3.*(vl|omni)/, name: 'Qwen3-VL', cat: 'Vision', reasoning: true, vision: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^qwen3.*coder/, name: 'Qwen3 Coder', cat: 'Coding', tools: true },
    { re: /^qwen3.*embed/, name: 'Qwen3 Embedding', cat: 'Embedding', embedding: true },
    { re: /^qwen3/, name: 'Qwen3', cat: 'Reasoning', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^qwen2\.5.*(vl|omni)/, name: 'Qwen2.5-VL', cat: 'Vision', vision: true, tools: true },
    { re: /^qwen2\.5.*coder/, name: 'Qwen2.5 Coder', cat: 'Coding', tools: true },
    { re: /^qwen/, name: 'Qwen', cat: 'Generalist', tools: true },
    { re: /^gpt-?oss/, name: 'gpt-oss', cat: 'Reasoning', reasoning: true, tools: true },
    { re: /^magistral/, name: 'Magistral', cat: 'Reasoning', reasoning: true, tools: true },
    { re: /^phi-?4.*(reasoning|mini-reasoning)/, name: 'Phi-4 Reasoning', cat: 'Reasoning', reasoning: true },
    { re: /^exaone.*deep/, name: 'EXAONE Deep', cat: 'Reasoning', reasoning: true },
    { re: /^seed-?oss/, name: 'Seed-OSS', cat: 'Reasoning', reasoning: true, tools: true },
    { re: /^glm-?4\.[5-9]|^glm-?[5-9]/, name: 'GLM', cat: 'Reasoning', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^minimax/, name: 'MiniMax', cat: 'Reasoning', reasoning: true, tools: true },
    { re: /^kimi.*(thinking|k2)/, name: 'Kimi K2', cat: 'Reasoning', reasoning: true, tools: true },
    { re: /nemotron/, name: 'Nemotron', cat: 'Reasoning', reasoning: true, tools: true, thinkingMinTemperature: THINKING_FLOOR_QWEN_DEEPSEEK },
    { re: /^smallthinker|^openthinker|^marco-?o1|^skywork-?o1/, name: 'Open reasoning model', cat: 'Reasoning', reasoning: true },

    // ── Vision-first families ────────────────────────────────────────────────
    // An OCR model reads PAGES. Matched on the word anywhere in the id because
    // this family is named every possible way (`glm-ocr`, `got-ocr2`,
    // `dots.ocr`, `nanonets-ocr-s`, `olmocr`) and none of them share a vendor
    // prefix to key off. A runtime that declares its own modalities outranks
    // this anyway (see local.js `declaredCapabilities`); the pattern is the
    // fallback for the ones that declare nothing, and calling an OCR model
    // text-only is the one mistake that makes it useless.
    { re: /ocr(\d|[-_.]|$)/, name: 'OCR model', cat: 'Vision', vision: true },
    { re: /^llama.*(vision|3\.2-vision)/, name: 'Llama Vision', cat: 'Vision', vision: true, tools: true },
    { re: /^llava|^bakllava|^moondream|^minicpm-?v|^internvl|^pixtral|^granite.*vision/, name: 'Vision model', cat: 'Vision', vision: true },
    { re: /^gemma-?3(?!.*\b1b\b)/, name: 'Gemma 3', cat: 'Vision', vision: true, tools: true },
    // Gemma 4 has a thinking mode and calls tools; without an entry it fell
    // through to the plain `^gemma` line below, and `isReasoningModel` then
    // said false — which is what decides whether a thinking tier gets its
    // reasoning UX at all. Vision is deliberately NOT claimed: the family is
    // multimodal, but a llama.cpp deployment without an mmproj file is not,
    // and a runtime that DOES serve vision declares it (capabilities win).
    // No thinkingMinTemperature on purpose — see the note above the table.
    { re: /^gemma-?4/, name: 'Gemma 4', cat: 'Reasoning', reasoning: true, tools: true },

    // ── Coding families ──────────────────────────────────────────────────────
    { re: /^codellama|^codegemma|^starcoder|^deepseek-?coder|^codestral|^devstral|^granite-?code|^opencoder/, name: 'Code model', cat: 'Coding', tools: true },

    // ── Embedding families ───────────────────────────────────────────────────
    { re: /^nomic-?embed|^mxbai-?embed|^bge-|^gte-|^e5-|^all-minilm|^snowflake-?arctic-?embed|embed(ding)?(-|$)/, name: 'Embedding model', cat: 'Embedding', embedding: true },

    // ── General instruct families ────────────────────────────────────────────
    { re: /^llama-?4|^llama4/, name: 'Llama 4', cat: 'Vision', vision: true, tools: true },
    { re: /^llama/, name: 'Llama', cat: 'Generalist', tools: true },
    { re: /^mistral-?small|^mistral-?nemo|^mistral-?large|^mistral|^mixtral|^ministral/, name: 'Mistral', cat: 'Generalist', tools: true },
    { re: /^gemma/, name: 'Gemma', cat: 'Generalist' },
    { re: /^phi/, name: 'Phi', cat: 'Generalist' },
    { re: /^granite/, name: 'Granite', cat: 'Generalist', tools: true },
    { re: /^olmo|^smollm|^tinyllama|^stablelm|^falcon|^yi(-|$)|^command-?r|^aya|^hermes|^dolphin|^solar|^zephyr|^openchat|^vicuna|^orca/, name: 'Open model', cat: 'Generalist' },
];

/**
 * Strip the decoration a runtime adds around the underlying model name so the
 * family patterns above can match all three shapes of the same model:
 *   Ollama         → `qwen3:30b-a3b-q4_K_M`
 *   vLLM / SGLang  → `Qwen/Qwen3-30B-A3B-Instruct-2507`
 *   llama.cpp      → `/models/Qwen3-30B-A3B-Q4_K_M.gguf`
 */
const TRAILING_DECORATION =
    /-(q\d[_a-z0-9]*|iq\d[_a-z0-9]*|fp\d+|bf16|f16|f32|int[48]|awq|gptq|gguf|mlx|instruct|it|chat|text|latest)$/;

function normalizeLocalModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    let id = modelId.trim().toLowerCase().replace(/\\/g, '/');
    // Keep only the last path segment. That strips a filesystem path
    // (llama.cpp reports the file it loaded) and an org prefix alike
    // (`qwen/…`, `hf.co/unsloth/…`, `/models/…`).
    id = id.slice(id.lastIndexOf('/') + 1);
    id = id.replace(/\.(gguf|safetensors|bin)$/, '');
    id = id.replace(/:/g, '-');
    // Peel trailing quantisation / format decoration until nothing is left to
    // peel — real ids stack several (`…-instruct-q4_k_m`).
    for (let i = 0; i < 4 && TRAILING_DECORATION.test(id); i++) {
        id = id.replace(TRAILING_DECORATION, '');
    }
    return id;
}

/**
 * Describe a locally served model: display name, category, capabilities.
 * Always returns an object — an unrecognised id still gets a sensible label.
 *
 * @param {string} modelId  raw id as reported by the runtime
 * @param {object} [hints]  runtime-reported extras, e.g. Ollama's
 *   { parameterSize: '30B', quantization: 'Q4_K_M', capabilities: ['vision','tools','thinking'] }
 * @returns {{id, name, family, cat, reasoning, vision, tools, embedding, thinkingMinTemperature: number|null, local: true}}
 */
function describeLocalModel(modelId, hints = {}) {
    const normalized = normalizeLocalModelId(modelId);
    const match = FAMILY_PATTERNS.find(p => p.re.test(normalized)) || null;

    // Ollama tells us the real capabilities — always prefer them over the
    // pattern guess. The others only give us the id, so the guess stands.
    const declared = Array.isArray(hints.capabilities) ? hints.capabilities.map(String) : null;
    const declaredHas = (cap) => !!declared && declared.includes(cap);

    const reasoning = declared ? declaredHas('thinking') : !!match?.reasoning;
    const vision = declared ? declaredHas('vision') : !!match?.vision;
    const tools = declared ? declaredHas('tools') : !!match?.tools;
    const embedding = declared ? declaredHas('embedding') : !!match?.embedding;

    let cat = match?.cat || 'Generalist';
    // Declared capabilities outrank the family guess for categorisation too.
    if (embedding) cat = 'Embedding';
    else if (declared && vision) cat = 'Vision';
    else if (declared && reasoning && cat === 'Generalist') cat = 'Reasoning';

    return {
        id: modelId,
        name: buildDisplayName(modelId, match, hints),
        family: match?.name || null,
        cat,
        reasoning,
        vision,
        tools,
        embedding,
        thinkingMinTemperature: typeof match?.thinkingMinTemperature === 'number' ? match.thinkingMinTemperature : null,
        local: true,
    };
}

/**
 * The documented thinking-mode temperature floor of a model's family, or
 * null when the family publishes none (Gemma 4, and any family the table
 * does not list). Read by the local adapter before it sends a request.
 */
function thinkingMinTemperature(modelId) {
    return describeLocalModel(modelId).thinkingMinTemperature;
}

/**
 * Human-friendly label. We keep the raw id recognisable (admins pick models by
 * the tag they pulled) but append the size/quantisation Ollama reports, which
 * is the thing that actually decides whether it fits in VRAM.
 */
function buildDisplayName(modelId, match, hints) {
    const base = String(modelId).replace(/^hf\.co\//i, '');
    const extras = [];
    if (hints.parameterSize) extras.push(hints.parameterSize);
    if (hints.quantization) extras.push(hints.quantization);
    if (!extras.length) return base;
    // Don't repeat a size that's already spelled out in the tag.
    const shown = extras.filter(e => !base.toLowerCase().includes(String(e).toLowerCase()));
    return shown.length ? `${base} (${shown.join(', ')})` : base;
}

// ─── Local-model registry (drives €0 cost accounting) ────────────────────────
// Bounded so a misconfigured gateway advertising thousands of ids can't grow
// the set without limit. Insertion order eviction is fine: the ids that matter
// are re-registered on every resolution.
const MAX_REGISTERED = 5000;
const _localModelIds = new Set();

/** Record that `modelId` is served by a locally hosted provider. */
function registerLocalModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    if (_localModelIds.has(modelId)) return;
    if (_localModelIds.size >= MAX_REGISTERED) {
        const oldest = _localModelIds.values().next().value;
        _localModelIds.delete(oldest);
    }
    _localModelIds.add(modelId);
}

/** True when the model is known to be served from a self-hosted runtime. */
function isLocalModel(modelId) {
    return !!modelId && _localModelIds.has(modelId);
}

// ─── Context windows reported by the runtime ─────────────────────────────────
// A self-hosted model's window is whatever the operator started the server
// with, and it is often SMALL: a 9B on the demo box ran two 16k slots while
// core/llm/contextPolicy assumed the 128k default for an unknown id and never
// folded — a 17k-token turn was a hard 400 from llama-server instead
// (2026-09-19). llama-server reports the per-slot window (`n_ctx` on /props and
// in /v1/models meta); the adapter records it here and the fold sizes itself
// on the real number. Same bound and eviction as the id registry.
const _contextWindows = new Map();

/** Record the per-request context window the runtime reported for `modelId`. */
function rememberLocalContextWindow(modelId, tokens) {
    const n = Number(tokens);
    if (!modelId || typeof modelId !== 'string' || !Number.isFinite(n) || n <= 0) return;
    if (!_contextWindows.has(modelId) && _contextWindows.size >= MAX_REGISTERED) {
        const oldest = _contextWindows.keys().next().value;
        _contextWindows.delete(oldest);
    }
    _contextWindows.set(modelId, Math.floor(n));
}

/** The runtime-reported window for `modelId`, or null when none was reported. */
function localContextWindowFor(modelId) {
    return (modelId && _contextWindows.get(modelId)) || null;
}

/** Test seam — drops every registration and reported window. */
function _resetLocalModelRegistry() {
    _localModelIds.clear();
    _contextWindows.clear();
}

module.exports = {
    LOCAL_RUNTIMES,
    LOCAL_PROVIDER_TYPES,
    isLocalProviderType,
    isPrivateHostUrl,
    normalizeLocalModelId,
    describeLocalModel,
    thinkingMinTemperature,
    registerLocalModel,
    isLocalModel,
    rememberLocalContextWindow,
    localContextWindowFor,
    _resetLocalModelRegistry,
};
