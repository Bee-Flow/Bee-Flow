/**
 * Local / self-hosted LLM runtime routes.
 *
 * Everything an admin needs to get Ollama, vLLM, llama.cpp (and friends)
 * serving models inside Bee Flow without hand-editing config:
 *
 *   GET  /ai/local-runtimes             — the runtime catalogue (labels, default
 *                                         URLs, whether a key is needed, docs)
 *   GET  /ai/local-runtimes/models      — curated starter models per use case
 *   POST /ai/local-runtimes/detect      — probe the usual local ports and report
 *                                         what is actually running
 *   POST /ai/local-runtimes/test        — probe one endpoint (the "Test
 *                                         connection" button)
 *   POST /ai/local-runtimes/:id/pull    — stream an Ollama model download
 *
 * All of these are admin-only. They make outbound HTTP calls to an
 * operator-supplied address, which is the same trust level as configuring a
 * provider URL — but it is emphatically not something a normal user should be
 * able to trigger.
 */

const router = require('express').Router();
const { requireAuth, hasPermission } = require('../../auth/permissions');
const { getProviders, invalidateModelCache } = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const { LOCAL_RUNTIMES, isLocalProviderType } = require('../../core/providers/localModels');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');

async function isAdminUser(req) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    return hasPermission(userId, 'admin_ai_config', req.session);
}

async function requireAdmin(req, res, next) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ── What a caller may send ───────────────────────────────────────────────────
// The endpoint is the one field that decides where the server makes an
// outbound request, so its shape is the SSRF guard: anything that is not
// http(s) — file:, gopher:, a bare host with no scheme — is refused here
// rather than handed to fetch().

const ENDPOINT_MALFORMED = 'Enter a full URL, for example http://localhost:11434';
const ENDPOINT_SCHEME = 'Only http:// and https:// endpoints are supported';
const EndpointUrl = z.string({ required_error: ENDPOINT_MALFORMED, invalid_type_error: ENDPOINT_MALFORMED })
    .trim()
    .transform((raw, ctx) => {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch (_) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: ENDPOINT_MALFORMED });
            return z.NEVER;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: ENDPOINT_SCHEME });
            return z.NEVER;
        }
        // One canonical spelling, so the detect route's "already configured"
        // comparison against a stored provider url is an equality test.
        return parsed.toString().replace(/\/+$/, '');
    });

const TestBody = z.object({
    type: z.string({ required_error: 'Pick a runtime type.', invalid_type_error: 'Pick a runtime type.' })
        .refine(isLocalProviderType, (t) => ({ message: `Unknown runtime type '${t}'` })),
    url: EndpointUrl,
    apiKey: z.string({ invalid_type_error: 'An API key must be text.' }).default(''),
}).strict();

const MODEL_REQUIRED = 'A model name is required';
const PullBody = z.object({
    model: z.string({ required_error: MODEL_REQUIRED, invalid_type_error: MODEL_REQUIRED })
        .trim().min(1, MODEL_REQUIRED),
}).strict();

// ─── Catalogue ───────────────────────────────────────────────────────────────

// GET /ai/local-runtimes — what can be connected, and how.
router.get('/local-runtimes', requireAuth, (_req, res) => {
    res.json({
        runtimes: Object.entries(LOCAL_RUNTIMES).map(([type, rt]) => ({
            type,
            label: rt.label,
            defaultUrl: rt.defaultUrl,
            needsApiKey: rt.needsApiKey,
            canPull: rt.canPull,
            description: rt.description,
            docsUrl: rt.docsUrl,
        })),
    });
});

// A short, opinionated starter list for Ollama — the point is that an admin who
// has never run a local model can get a working tier set in three clicks
// instead of reading a model leaderboard. `vram` is the rough floor for the
// listed quantisation, which is the number that actually decides what runs.
const STARTER_MODELS = [
    { model: 'qwen3:4b', label: 'Qwen3 4B', tier: 'fast', vram: '~4 GB', note: 'Fast tier on a laptop. Thinking + tool calling.' },
    { model: 'llama3.2:3b', label: 'Llama 3.2 3B', tier: 'fast', vram: '~3 GB', note: 'Smallest sensible chat model. CPU-friendly.' },
    { model: 'qwen3:8b', label: 'Qwen3 8B', tier: 'standard', vram: '~6 GB', note: 'Good all-round default for 8–12 GB GPUs.' },
    { model: 'gemma3:12b', label: 'Gemma 3 12B', tier: 'standard', vram: '~9 GB', note: 'Strong multilingual, reads images.' },
    { model: 'mistral-small3.2:24b', label: 'Mistral Small 3.2 24B', tier: 'standard', vram: '~15 GB', note: 'EU-built, vision + tool calling.' },
    { model: 'qwen3:30b-a3b', label: 'Qwen3 30B A3B', tier: 'thinking', vram: '~20 GB', note: 'MoE — 30B quality at 3B speed.' },
    { model: 'gpt-oss:20b', label: 'gpt-oss 20B', tier: 'thinking', vram: '~14 GB', note: 'Open-weight reasoning model with effort levels.' },
    { model: 'gpt-oss:120b', label: 'gpt-oss 120B', tier: 'deep_thinking', vram: '~65 GB', note: 'Frontier-class reasoning. Needs a serious GPU.' },
    { model: 'deepseek-r1:32b', label: 'DeepSeek-R1 32B', tier: 'deep_thinking', vram: '~20 GB', note: 'Long chain-of-thought reasoning.' },
    { model: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', tier: null, vram: '~10 GB', note: 'Code generation and review.' },
    { model: 'qwen3-vl:8b', label: 'Qwen3-VL 8B', tier: null, vram: '~7 GB', note: 'Vision — screenshots, scans, diagrams.' },
    { model: 'nomic-embed-text', label: 'Nomic Embed Text', tier: null, vram: '~1 GB', note: 'Embeddings for the knowledge base.' },
];

// GET /ai/local-runtimes/models — curated starter models (Ollama tags).
router.get('/local-runtimes/models', requireAuth, (_req, res) => {
    res.json({ models: STARTER_MODELS });
});

// ─── Probing ─────────────────────────────────────────────────────────────────

/** Probe a single endpoint and normalise the adapter's answer for the UI. */
async function probeEndpoint({ type, url, apiKey }) {
    const adapter = getAdapter(type, url);
    if (typeof adapter.probe !== 'function') {
        return { ok: false, error: `'${type}' is not a self-hosted runtime type` };
    }
    const result = await adapter.probe(apiKey || '', url);
    return {
        ok: result.ok,
        type,
        url,
        label: LOCAL_RUNTIMES[type]?.label || type,
        version: result.version,
        modelCount: result.modelCount,
        // Only the ids and labels — the full descriptors are what
        // /ai/providers/:id/models is for.
        models: result.models.slice(0, 200).map(m => ({ id: m.id, name: m.name, cat: m.cat })),
        error: result.error,
    };
}

// POST /ai/local-runtimes/test — { type, url, apiKey? }
router.post('/local-runtimes/test', requireAuth, requireAdmin, validate({ body: TestBody }), async (req, res) => {
    const { type, url, apiKey } = req.body;
    try {
        res.json(await probeEndpoint({ type, url, apiKey }));
    } catch (e) {
        // A runtime that is not running is an ANSWER, not a server fault: the
        // Test-connection button is asking exactly this question.
        res.json({ ok: false, type, url, modelCount: 0, models: [], error: e.message });
    }
});

// Where a local runtime realistically lives, in probe order. `host.docker.internal`
// covers the common case of Bee Flow in Docker and Ollama on the host; the
// service names cover a compose stack where they share a network.
const DETECT_HOSTS = ['localhost', 'host.docker.internal'];
const DETECT_TARGETS = [
    { type: 'ollama', port: 11434, path: '' },
    { type: 'lmstudio', port: 1234, path: '/v1' },
    { type: 'vllm', port: 8000, path: '/v1' },
    { type: 'llamacpp', port: 8080, path: '/v1' },
    { type: 'sglang', port: 30000, path: '/v1' },
    { type: 'jan', port: 1337, path: '/v1' },
    { type: 'koboldcpp', port: 5001, path: '/v1' },
];
// Service-name candidates, so a compose/K8s deployment is found without the
// admin knowing the internal DNS name.
const DETECT_SERVICES = [
    { type: 'ollama', url: 'http://ollama:11434' },
    { type: 'vllm', url: 'http://vllm:8000/v1' },
    { type: 'llamacpp', url: 'http://llamacpp:8080/v1' },
];

// POST /ai/local-runtimes/detect — scan the usual suspects.
// Fixed candidate list only: it never probes a caller-supplied address, so it
// cannot be used as a port scanner.
router.post('/local-runtimes/detect', requireAuth, requireAdmin, async (_req, res) => {
    const candidates = [
        ...DETECT_HOSTS.flatMap(host =>
            DETECT_TARGETS.map(t => ({ type: t.type, url: `http://${host}:${t.port}${t.path}` }))
        ),
        ...DETECT_SERVICES,
    ];

    const settled = await Promise.all(candidates.map(async (c) => {
        try {
            const r = await probeEndpoint(c);
            return r.ok && r.modelCount > 0 ? r : null;
        } catch (_) {
            return null;
        }
    }));

    const { providers } = await getProviders();
    const configured = new Set((providers || []).map(p => (p.url || '').replace(/\/+$/, '')));

    const found = settled.filter(Boolean).map(r => ({ ...r, alreadyConfigured: configured.has(r.url) }));
    res.json({ found, probed: candidates.length });
});

// ─── Model downloads (Ollama) ────────────────────────────────────────────────

// POST /ai/local-runtimes/:id/pull — { model }
// Streams Ollama's native NDJSON progress through as SSE so the admin UI can
// show a real progress bar; a multi-GB pull is not something to run blind.
router.post('/local-runtimes/:id/pull', requireAuth, requireAdmin, validate({ body: PullBody }), async (req, res) => {
    const { model } = req.body;

    const { providers } = await getProviders();
    const provider = (providers || []).find(p => p.id === req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    if (!isLocalProviderType(provider.type)) {
        return res.status(400).json({ error: 'That provider is not a self-hosted runtime' });
    }

    const adapter = getAdapter(provider.type, provider.url);
    if (typeof adapter.pullModel !== 'function' || !LOCAL_RUNTIMES[provider.type]?.canPull) {
        return res.status(400).json({
            error: `${LOCAL_RUNTIMES[provider.type]?.label || provider.type} cannot download models over the API — load the model when starting the server.`,
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        await adapter.pullModel(provider.apiKey || '', provider.url, model, (progress) => {
            send('progress', {
                status: progress.status || '',
                completed: progress.completed ?? null,
                total: progress.total ?? null,
            });
        });
        // The new tag has to show up in the tier picker without a restart.
        invalidateModelCache(provider.id);
        send('done', { model });
    } catch (e) {
        send('error', { error: e.message });
    } finally {
        res.end();
    }
});

module.exports = router;
