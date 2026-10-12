/**
 * Unit tests — local / self-hosted runtime adapter + open-weight model table.
 *
 * Run: node --test core/providers/local.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const LocalProvider = require('./local');
const { getAdapter } = require('./index');
const {
    describeLocalModel,
    normalizeLocalModelId,
    isLocalModel,
    registerLocalModel,
    isLocalProviderType,
    isPrivateHostUrl,
    _resetLocalModelRegistry,
} = require('./localModels');

// ─── id normalisation ────────────────────────────────────────────────────────

test('normalises the three shapes runtimes report the same model as', () => {
    // Ollama tag, HF repo id (vLLM/SGLang), GGUF file path (llama.cpp).
    assert.strictEqual(normalizeLocalModelId('qwen3:30b-a3b-q4_K_M'), 'qwen3-30b-a3b');
    assert.strictEqual(normalizeLocalModelId('Qwen/Qwen3-30B-A3B'), 'qwen3-30b-a3b');
    assert.strictEqual(normalizeLocalModelId('/models/Qwen3-30B-A3B-Q4_K_M.gguf'), 'qwen3-30b-a3b');
});

test('strips an hf.co org prefix and stacked decoration', () => {
    assert.strictEqual(
        normalizeLocalModelId('hf.co/unsloth/gpt-oss-20b-GGUF:Q4_K_M'),
        'gpt-oss-20b',
    );
});

// ─── family metadata ─────────────────────────────────────────────────────────

test('classifies open-weight families into tier-picker categories', () => {
    assert.strictEqual(describeLocalModel('deepseek-r1:32b').cat, 'Reasoning');
    assert.strictEqual(describeLocalModel('qwen2.5-coder:14b').cat, 'Coding');
    assert.strictEqual(describeLocalModel('qwen3-vl:8b').cat, 'Vision');
    assert.strictEqual(describeLocalModel('nomic-embed-text').cat, 'Embedding');
    assert.strictEqual(describeLocalModel('llama3.2:3b').cat, 'Generalist');
});

test('flags reasoning and vision on the families that have them', () => {
    assert.strictEqual(describeLocalModel('qwen3:8b').reasoning, true);
    assert.strictEqual(describeLocalModel('gpt-oss:120b').reasoning, true);
    assert.strictEqual(describeLocalModel('llama3.2:3b').reasoning, false);
    assert.strictEqual(describeLocalModel('gemma3:12b').vision, true);
});

test('Gemma 4 reads as a reasoning, tool-calling family — Gemma 3 stays vision', () => {
    // The local box runs `gemma-4-26b-a4b` through llama.cpp, which declares no
    // capabilities, so the family guess is the only thing that turns the
    // thinking tiers' reasoning UX on (core/llm/modelResolver.isReasoningModel).
    const g4 = describeLocalModel('gemma-4-26b-a4b');
    assert.strictEqual(g4.family, 'Gemma 4');
    assert.strictEqual(g4.cat, 'Reasoning');
    assert.strictEqual(g4.reasoning, true);
    assert.strictEqual(g4.tools, true);
    // Not vision: this deployment has no mmproj. A runtime that serves vision
    // declares it, and declared capabilities outrank the guess (test below).
    assert.strictEqual(g4.vision, false);
    // The older family keeps its own answer, and the bare name still resolves.
    assert.strictEqual(describeLocalModel('gemma3:12b').vision, true);
    assert.strictEqual(describeLocalModel('gemma2:9b').family, 'Gemma');
    // The embedding sibling must not be swallowed by the Gemma patterns.
    assert.strictEqual(describeLocalModel('embedding-gemma').cat, 'Embedding');
});

test("Ollama's declared capabilities outrank the family guess", () => {
    // A fine-tune whose name says nothing: the runtime is the authority.
    const m = describeLocalModel('some-private-finetune:latest', {
        capabilities: ['completion', 'tools', 'vision', 'thinking'],
    });
    assert.strictEqual(m.reasoning, true);
    assert.strictEqual(m.vision, true);
    assert.strictEqual(m.tools, true);
    assert.strictEqual(m.cat, 'Vision');
});

test('declared capabilities can also turn a family guess OFF', () => {
    // Qwen3 normally thinks; the instruct-only build served here does not.
    const m = describeLocalModel('qwen3:8b', { capabilities: ['completion', 'tools'] });
    assert.strictEqual(m.reasoning, false);
    assert.strictEqual(m.tools, true);
});

test('appends the size/quantisation an admin needs to judge VRAM fit', () => {
    const m = describeLocalModel('qwen3:30b', { parameterSize: '30.5B', quantization: 'Q4_K_M' });
    assert.strictEqual(m.name, 'qwen3:30b (30.5B, Q4_K_M)');
});

// ─── adapter wiring ──────────────────────────────────────────────────────────

test('resolves every runtime type to a LocalProvider of that flavour', () => {
    for (const type of ['ollama', 'vllm', 'llamacpp', 'lmstudio', 'sglang', 'localai', 'tgi', 'openai-compatible']) {
        const adapter = getAdapter(type);
        assert.ok(adapter instanceof LocalProvider, `${type} → LocalProvider`);
        assert.strictEqual(adapter.flavor, type);
        assert.strictEqual(isLocalProviderType(type), true);
    }
});

test('auto-detects a runtime from its default port when no type is stored', () => {
    assert.strictEqual(getAdapter(null, 'http://localhost:11434').flavor, 'ollama');
    assert.strictEqual(getAdapter(null, 'http://localhost:8000/v1').flavor, 'vllm');
    assert.strictEqual(getAdapter(null, 'http://ollama:11434').flavor, 'ollama');
    assert.strictEqual(getAdapter(null, 'http://192.168.1.50:8080/v1').flavor, 'llamacpp');
    // An explicit type always beats the URL guess.
    assert.strictEqual(getAdapter('vllm', 'http://localhost:11434').flavor, 'vllm');
});

test('a PUBLIC host on a runtime port is NOT guessed to be self-hosted', () => {
    // A LiteLLM proxy fronting a paid API listens on :8000 just like vLLM.
    // Guessing local there would bill real API spend at €0, so a port number
    // only counts as evidence on the operator's own network.
    assert.strictEqual(getAdapter(null, 'https://llm.company.com:8000/v1').name, 'generic');
    assert.strictEqual(getAdapter(null, 'https://gateway.example.org:8080/v1').name, 'generic');
    // An explicit type still works for a remote GPU box the operator owns.
    assert.strictEqual(getAdapter('vllm', 'https://gpu.company.com:8000/v1').flavor, 'vllm');
});

test('isPrivateHostUrl accepts own-network addresses and rejects public ones', () => {
    for (const url of [
        'http://localhost:11434', 'http://127.0.0.1:8000', 'http://[::1]:8000',
        'http://host.docker.internal:11434', 'http://ollama:11434',
        'http://10.0.0.5:8000', 'http://192.168.1.50:8080', 'http://172.16.4.2:8000',
        'http://gpu-box.local:8000', 'http://gpu.internal:8000',
    ]) {
        assert.strictEqual(isPrivateHostUrl(url), true, url);
    }
    for (const url of [
        'https://llm.company.com:8000/v1', 'https://api.openai.com/v1',
        'http://8.8.8.8:8000', 'http://172.32.0.1:8000', 'not a url',
    ]) {
        assert.strictEqual(isPrivateHostUrl(url), false, url);
    }
});

test('cloud providers are unaffected by the local URL patterns', () => {
    assert.strictEqual(getAdapter(null, 'https://api.openai.com/v1').name, 'openai');
    assert.strictEqual(getAdapter(null, 'https://api.mistral.ai/v1').name, 'mistral');
});

// ─── request building ────────────────────────────────────────────────────────

test('sends no Authorization header when the runtime is keyless', () => {
    const ollama = new LocalProvider('ollama');
    assert.strictEqual(ollama.getHeaders('').Authorization, undefined);
    assert.strictEqual(ollama.getHeaders(null).Authorization, undefined);
    // vLLM/llama.cpp with --api-key still get one.
    assert.strictEqual(ollama.getHeaders('secret').Authorization, 'Bearer secret');
});

test("maps the tier's reasoningEffort onto Ollama's reasoning_effort", () => {
    const ollama = new LocalProvider('ollama');
    const effort = (opts) => ollama.buildRequestBody('qwen3:8b', [], opts).reasoning_effort;
    assert.strictEqual(effort({ reasoningEffort: 'low' }), 'low');
    assert.strictEqual(effort({ reasoningEffort: 'minimal' }), 'low');
    assert.strictEqual(effort({ reasoningEffort: 'medium' }), 'medium');
    assert.strictEqual(effort({ reasoningEffort: 'high' }), 'high');
    assert.strictEqual(effort({ reasoningEffort: 'xhigh' }), 'high');
    assert.strictEqual(effort({ reasoningEffort: 'none' }), 'none');
    // Title generation passes budgetTokens: 0 — that means "don't think".
    assert.strictEqual(effort({ budgetTokens: 0 }), 'none');
    // No preference expressed → send nothing, let the model default apply.
    assert.strictEqual(effort({}), undefined);

    // `think` is the NATIVE /api/chat field. We post to the OpenAI-compatible
    // route, which drops it silently — sending it meant the tier's Reasoning
    // Effort did nothing at all, "None" included. Verified against Ollama
    // 0.33.2: with `think: false` a qwen3 reply still carried 531 characters
    // of reasoning; with `reasoning_effort: 'none'` it carried none.
    assert.strictEqual(ollama.buildRequestBody('qwen3:8b', [], { reasoningEffort: 'none' }).think, undefined);
});

test('never sends reasoning_effort to an Ollama model that cannot think', () => {
    const ollama = new LocalProvider('ollama');
    const effort = (model, opts) => ollama.buildRequestBody(model, [], opts).reasoning_effort;

    // Ollama answers 400 '"llama3.2:1b" does not support thinking' rather than
    // ignoring the field, so a tier whose effort outlived a switch to a
    // non-reasoning model would break every request. The tier UI hides the
    // control for these models but never clears the stored value, so the
    // adapter is what has to hold the line.
    for (const model of ['llama3.2:1b', 'gemma3:270m', 'mistral:7b', 'phi4-mini:latest']) {
        assert.strictEqual(effort(model, { reasoningEffort: 'low' }), undefined, model);
        assert.strictEqual(effort(model, { reasoningEffort: 'none' }), undefined, model);
    }
    // Reasoning families still get it.
    for (const model of ['qwen3:8b', 'deepseek-r1:7b', 'gpt-oss:20b', 'magistral:24b']) {
        assert.strictEqual(effort(model, { reasoningEffort: 'high' }), 'high', model);
    }
});

test('maps reasoning onto chat_template_kwargs for vLLM/SGLang', () => {
    const vllm = new LocalProvider('vllm');
    assert.deepStrictEqual(
        vllm.buildRequestBody('Qwen/Qwen3-8B', [], { reasoningEffort: 'high' }).chat_template_kwargs,
        { enable_thinking: true },
    );
    assert.deepStrictEqual(
        vllm.buildRequestBody('Qwen/Qwen3-8B', [], { reasoningEffort: 'none' }).chat_template_kwargs,
        { enable_thinking: false },
    );
    assert.strictEqual(
        vllm.buildRequestBody('Qwen/Qwen3-8B', [], {}).chat_template_kwargs,
        undefined,
    );
    // `think` is Ollama-only — it must not leak onto an OpenAI-shaped server.
    assert.strictEqual(vllm.buildRequestBody('Qwen/Qwen3-8B', [], { reasoningEffort: 'high' }).think, undefined);
});

test('thinking mode never runs greedy on llama.cpp / vLLM', () => {
    // Qwen3 / DeepSeek-R1 document ≥ 0.6 for thinking mode; the builder's
    // 0.0-0.2 (stable tool JSON) is right only with thinking OFF. Measured on
    // the demo box: 0.1 + thinking reasoned for 8192 tokens without converging.
    const temp = (flavor, opts) => new LocalProvider(flavor).buildRequestBody('qwen3.6-35b-a3b', [], opts).temperature;
    assert.strictEqual(temp('llamacpp', { temperature: 0.1, reasoningEffort: 'low' }), 0.6, 'lifted to the floor');
    assert.strictEqual(temp('vllm', { temperature: 0.1, reasoningEffort: 'high' }), 0.6, 'same on vLLM');
    assert.strictEqual(temp('llamacpp', { temperature: 0.8, reasoningEffort: 'low' }), 0.8, 'above the floor: untouched');
    assert.strictEqual(temp('llamacpp', { temperature: 0.1, reasoningEffort: 'none' }), 0.1, 'thinking off keeps the caller\'s value');
    assert.strictEqual(temp('llamacpp', { temperature: 0.1 }), 0.1, 'no preference → nothing sent about thinking, nothing changed');
    assert.strictEqual(temp('llamacpp', { reasoningEffort: 'low' }), undefined, 'no temperature stays absent (the preset applies)');
    assert.strictEqual(temp('ollama', { temperature: 0.1, reasoningEffort: 'low' }), 0.1, 'Ollama branch untouched');
    assert.strictEqual(temp('llamacpp', { temperature: 0.1, reasoningEffort: 'low', extraBody: { temperature: 0.1 } }), 0.1, 'extraBody still wins');
});

test('keeps the OpenAI body shape and lets extraBody override everything', () => {
    const vllm = new LocalProvider('vllm');
    const body = vllm.buildRequestBody('m', [{ role: 'user', content: 'hi' }], {
        maxTokens: 256,
        temperature: 0.4,
        topK: 40,
        extraBody: { top_k: 20, guided_json: { type: 'object' } },
    });
    assert.strictEqual(body.model, 'm');
    assert.strictEqual(body.max_tokens, 256);
    assert.strictEqual(body.temperature, 0.4);
    assert.strictEqual(body.top_k, 20);            // extraBody wins
    assert.deepStrictEqual(body.guided_json, { type: 'object' });
});

// ─── discovery ───────────────────────────────────────────────────────────────

test('discovers Ollama models natively, with real capability flags', async (t) => {
    _resetLocalModelRegistry();
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
        calls.push(String(url));
        if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({
                models: [
                    { model: 'qwen3:8b', details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' }, size: 5200000000 },
                    { model: 'llama3.2:3b', details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M' }, size: 2000000000 },
                ],
            }), { status: 200 });
        }
        if (String(url).endsWith('/api/show')) {
            const { model } = JSON.parse(opts.body);
            return new Response(JSON.stringify({
                capabilities: model === 'qwen3:8b' ? ['completion', 'tools', 'thinking'] : ['completion', 'tools'],
            }), { status: 200 });
        }
        throw new Error(`unexpected call: ${url}`);
    });

    const models = await new LocalProvider('ollama').listModels('', 'http://localhost:11434');

    assert.deepStrictEqual(models.map(m => m.id), ['qwen3:8b', 'llama3.2:3b']);
    assert.strictEqual(models[0].reasoning, true);
    assert.strictEqual(models[1].reasoning, false);
    assert.strictEqual(models[0].name, 'qwen3:8b (8.2B, Q4_K_M)');
    // Never touched the OpenAI-compatible route.
    assert.ok(!calls.some(c => c.includes('/v1/models')));
    // Discovery must NOT itself claim these as free-to-run: the adapter can be
    // reached by a URL guess, and only the stored provider type is proof. That
    // call belongs to getModelsForProvider.
    assert.strictEqual(isLocalModel('qwen3:8b'), false);
});

test('falls back to /v1/models when the Ollama native API is unreachable', async (t) => {
    _resetLocalModelRegistry();
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url).endsWith('/api/tags')) return new Response('nope', { status: 404 });
        if (String(url).endsWith('/v1/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), { status: 200 });
        }
        throw new Error(`unexpected call: ${url}`);
    });

    const models = await new LocalProvider('ollama').listModels('', 'http://localhost:11434');
    assert.deepStrictEqual(models.map(m => m.id), ['qwen3:8b']);
});

test('discovers vLLM models over /v1/models, appending /v1 only when needed', async (t) => {
    _resetLocalModelRegistry();
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: 'Qwen/Qwen3-30B-A3B' }] }), { status: 200 });
    });

    const vllm = new LocalProvider('vllm');
    await vllm.listModels('', 'http://localhost:8000/v1');
    await vllm.listModels('', 'http://localhost:8000');
    assert.deepStrictEqual(urls, [
        'http://localhost:8000/v1/models',
        'http://localhost:8000/v1/models',
    ]);
});

// ─── declared modalities ─────────────────────────────────────────────────────

test('a runtime that declares image input is believed over the name guess', async (t) => {
    // llama.cpp answers /v1/models with what it actually serves. `glm-ocr`
    // matches no vendor regex, so before this the guess won and every
    // documentMode:'images' step against it failed vision_required — the model
    // could see and the platform said it could not.
    _resetLocalModelRegistry();
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        data: [{ id: 'some-unknown-name-v2', architecture: { input_modalities: ['text', 'image'] } }],
    }), { status: 200 }));

    const models = await new LocalProvider('llamacpp').listModels('', 'http://localhost:8080/v1');
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].vision, true, 'declared image input must win');
    assert.strictEqual(models[0].cat, 'Vision');
});

test('a runtime that declares nothing leaves the family guess in charge', async (t) => {
    // Silence is not a denial. Reading a missing architecture block as
    // "text-only" would turn every runtime that omits it into a fleet of
    // models that cannot see.
    _resetLocalModelRegistry();
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        data: [{ id: 'gemma-3-27b' }, { id: 'qwen3-vl-8b' }],
    }), { status: 200 }));

    const models = await new LocalProvider('llamacpp').listModels('', 'http://localhost:8080/v1');
    assert.deepStrictEqual(models.map((m) => m.vision), [true, true]);
});

test('declared text-only does not strip tools or thinking off the family guess', async (t) => {
    // input_modalities says what a model can READ. It is not an opinion about
    // tool calling, and a runtime listing only 'text' must not silently
    // demote a tool-calling model to one that cannot call tools.
    _resetLocalModelRegistry();
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        data: [{ id: 'gemma-4-26b-a4b', architecture: { input_modalities: ['text'] } }],
    }), { status: 200 }));

    const [model] = await new LocalProvider('llamacpp').listModels('', 'http://localhost:8080/v1');
    assert.strictEqual(model.vision, false);
    assert.strictEqual(model.tools, true, 'tools survive a text-only modality list');
    assert.strictEqual(model.reasoning, true, 'so does thinking');
});

test('an OCR model is vision-capable even when the runtime says nothing', () => {
    // The fallback for runtimes that declare no modalities. An OCR model that
    // the platform believes cannot read images is useless.
    for (const id of ['glm-ocr', 'olmocr', 'got-ocr2', 'dots.ocr', 'nanonets-ocr-s']) {
        assert.strictEqual(describeLocalModel(id).vision, true, `${id} should be vision`);
    }
    // …without swallowing names that merely contain the letters.
    assert.strictEqual(describeLocalModel('ocrolus-7b').vision, false);
});

test('an unreachable runtime yields 0 models rather than throwing', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
    const models = await new LocalProvider('llamacpp').listModels('', 'http://localhost:8080/v1');
    assert.deepStrictEqual(models, []);
});

// ─── probe ───────────────────────────────────────────────────────────────────

test('probe reports a reachable-but-empty runtime as ok with an explanation', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url).endsWith('/api/version')) return new Response(JSON.stringify({ version: '0.12.0' }), { status: 200 });
        if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await new LocalProvider('ollama').probe('', 'http://localhost:11434');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, '0.12.0');
    assert.strictEqual(result.modelCount, 0);
    assert.match(result.error, /no models/i);
});

// ─── pulls ───────────────────────────────────────────────────────────────────

test('refuses to pull on runtimes that load models at start-up', async () => {
    await assert.rejects(
        () => new LocalProvider('vllm').pullModel('', 'http://localhost:8000/v1', 'qwen3:8b', () => {}),
        /cannot download models/i,
    );
});

test('streams Ollama pull progress as parsed NDJSON objects', async (t) => {
    const lines = [
        '{"status":"pulling manifest"}',
        '{"status":"downloading","completed":50,"total":100}',
        '{"status":"success"}',
    ].join('\n') + '\n';

    t.mock.method(globalThis, 'fetch', async () => new Response(
        new ReadableStream({
            start(controller) {
                // Split mid-line to prove the buffer handles partial chunks.
                controller.enqueue(new TextEncoder().encode(lines.slice(0, 40)));
                controller.enqueue(new TextEncoder().encode(lines.slice(40)));
                controller.close();
            },
        }),
        { status: 200 },
    ));

    const seen = [];
    await new LocalProvider('ollama').pullModel('', 'http://localhost:11434', 'qwen3:8b', p => seen.push(p));
    assert.deepStrictEqual(seen.map(p => p.status), ['pulling manifest', 'downloading', 'success']);
    assert.strictEqual(seen[1].completed, 50);
});

test('surfaces an error object mid-stream instead of reporting success', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"error":"model not found"}\n'));
                controller.close();
            },
        }),
        { status: 200 },
    ));

    await assert.rejects(
        () => new LocalProvider('ollama').pullModel('', 'http://localhost:11434', 'nope', () => {}),
        /model not found/,
    );
});

// ─── registry ────────────────────────────────────────────────────────────────

test('the local registry only claims models it was told about', () => {
    _resetLocalModelRegistry();
    assert.strictEqual(isLocalModel('qwen3:8b'), false);
    registerLocalModel('qwen3:8b');
    assert.strictEqual(isLocalModel('qwen3:8b'), true);
    // A cloud-hosted model of the same family is NOT local.
    assert.strictEqual(isLocalModel('qwen3-235b-a22b'), false);
});

// ─── capabilities the runtime reported, reused at request time ───────────────

test('a runtime-reported capability outranks the name guess when building a request', async (t) => {
    LocalProvider._resetCapabilityCache();
    const ollama = new LocalProvider('ollama');
    const effortFor = (id) => ollama.buildRequestBody(id, [], { reasoningEffort: 'high' }).reasoning_effort;

    // A fine-tune whose NAME reveals nothing. Before discovery all we can do is
    // guess from the tag, and the guess is "not a reasoning model" — a safe
    // failure: Ollama 400s on reasoning_effort for a model that cannot think.
    assert.strictEqual(effortFor('support-triage:latest'), undefined);

    t.mock.method(globalThis, 'fetch', async (url, opts) => {
        if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({
                models: [{ model: 'support-triage:latest' }, { model: 'desk-classify:v2' }],
            }), { status: 200 });
        }
        if (String(url).endsWith('/api/show')) {
            const { model } = JSON.parse(opts.body);
            return new Response(JSON.stringify({
                capabilities: model === 'support-triage:latest'
                    ? ['completion', 'tools', 'thinking']
                    : ['completion'],
            }), { status: 200 });
        }
        throw new Error(`unexpected call: ${url}`);
    });

    await ollama.listModels('', 'http://localhost:11434');

    // Discovery asked the runtime; request building now knows the answer.
    assert.strictEqual(effortFor('support-triage:latest'), 'high');
    // …and still withholds it from the one that genuinely cannot think.
    assert.strictEqual(effortFor('desk-classify:v2'), undefined);
});

test('a local runtime owns the Reasoning Summary switch', () => {
    assert.strictEqual(new LocalProvider('ollama').surfacesRawReasoning(), true);
    assert.strictEqual(new LocalProvider('vllm').surfacesRawReasoning(), true);
});

test('asks every OpenAI-compatible runtime for the trailing usage chunk when streaming', () => {
    for (const flavor of ['llamacpp', 'openai-compatible', 'vllm', 'lmstudio', 'ollama']) {
        const p = new LocalProvider(flavor);
        assert.deepStrictEqual(
            p.buildRequestBody('Qwen3-8B-GGUF', [], { stream: true }).stream_options,
            { include_usage: true },
            flavor,
        );
        assert.strictEqual(
            p.buildRequestBody('Qwen3-8B-GGUF', [], { stream: false }).stream_options,
            undefined,
            flavor,
        );
    }
});

test('sends reasoning_effort to llama.cpp next to enable_thinking, and to nothing else', () => {
    // Measured on the demo box: llama-server reads `reasoning_effort` per
    // request ('none' = off, a level goes to the template), a generic
    // OpenAI-shaped server may not know the field. So it rides on the runtime,
    // not on the flavor the admin picked.
    const llamacpp = new LocalProvider('llamacpp');
    assert.strictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'high' }).reasoning_effort, 'high');
    assert.strictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'xhigh' }).reasoning_effort, 'xhigh');
    assert.strictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'none' }).reasoning_effort, 'none');
    assert.deepStrictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'none' }).chat_template_kwargs, { enable_thinking: false });
    // An unknown spelling falls back to the template default rather than a 400.
    assert.strictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'turbo' }).reasoning_effort, 'medium');
    // No preference → nothing sent, the model's own default applies.
    assert.strictEqual(llamacpp.buildRequestBody('qwen3.6-35b-a3b', [], {}).reasoning_effort, undefined);

    // A generic endpoint that turned out to be llama-server (probe result
    // threaded in by chat()/stream()) gets the same treatment…
    const generic = new LocalProvider('openai-compatible');
    assert.strictEqual(generic.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'low', _runtime: 'llamacpp' }).reasoning_effort, 'low');
    // …and one that did not, or vLLM/SGLang by flavor, never sees the field.
    assert.strictEqual(generic.buildRequestBody('qwen3.6-35b-a3b', [], { reasoningEffort: 'low', _runtime: 'other' }).reasoning_effort, undefined);
    assert.strictEqual(new LocalProvider('vllm').buildRequestBody('Qwen/Qwen3-8B', [], { reasoningEffort: 'high' }).reasoning_effort, undefined);
});

test('detects llama-server behind a generic URL once per root, via /props', async () => {
    const generic = new LocalProvider('openai-compatible');
    let calls = 0;
    generic._getJson = async (url) => { calls++; assert.match(url, /\/props$/); return { build_info: 'b7000-abc', chat_template: '…' }; };
    assert.strictEqual(await generic._runtimeFor('', 'http://box.test:8080/v1'), 'llamacpp');
    assert.strictEqual(await generic._runtimeFor('', 'http://box.test:8080/v1/'), 'llamacpp');
    assert.strictEqual(calls, 1, 'the probe result is cached per API root');

    const strict = new LocalProvider('openai-compatible');
    strict._getJson = async () => { throw new Error('404'); };
    assert.strictEqual(await strict._runtimeFor('', 'http://other.test/v1'), 'other');
    // The flavor is authoritative when it names the runtime — no probe at all.
    const named = new LocalProvider('llamacpp');
    named._getJson = async () => { throw new Error('must not probe'); };
    assert.strictEqual(await named._runtimeFor('', 'http://named.test/v1'), 'llamacpp');
    assert.strictEqual(await new LocalProvider('ollama')._runtimeFor('', 'http://o.test'), 'ollama');
});

test('learns a model\'s per-slot context window from llama-server once, for the emergency fold', async () => {
    const { localContextWindowFor, _resetLocalModelRegistry } = require('./localModels');
    _resetLocalModelRegistry();
    const box = new LocalProvider('llamacpp');
    const urls = [];
    box._getJson = async (url) => {
        urls.push(url);
        // What the demo box answered on 2026-09-19: --ctx-size 32768 over
        // --parallel 2 is a 16384-token window per request.
        return { default_generation_settings: { n_ctx: 16384 }, total_slots: 2 };
    };
    await box._learnContextWindow('', 'http://box.test:8080/v1', 'qwen3.5-9b', 'llamacpp');
    await box._learnContextWindow('', 'http://box.test:8080/v1/', 'qwen3.5-9b', 'llamacpp');
    assert.deepStrictEqual(urls, ['http://box.test:8080/props?model=qwen3.5-9b'], 'one probe per (root, model), against the root, not /v1');
    assert.strictEqual(localContextWindowFor('qwen3.5-9b'), 16384);

    // The policy sizes the fold on the reported number instead of the 128k guess.
    const { contextWindowFor, overflowTokensFor } = require('../llm/contextPolicy');
    assert.strictEqual(contextWindowFor('qwen3.5-9b'), 16384);
    assert.strictEqual(overflowTokensFor('qwen3.5-9b', 75), 12288);
    assert.strictEqual(contextWindowFor('never-probed-model'), 128_000);

    // A runtime that is not llama-server is never asked; a failing probe is
    // remembered as a miss and leaves the default in place.
    const other = new LocalProvider('vllm');
    other._getJson = async () => { throw new Error('must not probe'); };
    await other._learnContextWindow('', 'http://v.test/v1', 'Qwen/Qwen3-8B', 'other');
    let failing = 0;
    const flaky = new LocalProvider('llamacpp');
    flaky._getJson = async () => { failing++; throw new Error('ECONNREFUSED'); };
    await flaky._learnContextWindow('', 'http://down.test/v1', 'gemma-4-26b-a4b', 'llamacpp');
    await flaky._learnContextWindow('', 'http://down.test/v1', 'gemma-4-26b-a4b', 'llamacpp');
    assert.strictEqual(failing, 1);
    assert.strictEqual(localContextWindowFor('gemma-4-26b-a4b'), null);
    _resetLocalModelRegistry();
});

test('discovery records the per-slot window llama-server lists under meta.n_ctx', async () => {
    const { localContextWindowFor, _resetLocalModelRegistry } = require('./localModels');
    _resetLocalModelRegistry();
    const box = new LocalProvider('llamacpp');
    box._getJson = async () => ({ data: [
        { id: 'qwen3.5-9b', meta: { n_ctx: 16384, n_ctx_train: 262144 } },
        { id: 'glm-ocr' }, // unloaded: no meta yet
    ] });
    const models = await box.listModels('', 'http://box.test:8080/v1');
    assert.deepStrictEqual(models.map(m => m.id), ['qwen3.5-9b', 'glm-ocr']);
    assert.strictEqual(localContextWindowFor('qwen3.5-9b'), 16384, 'the per-slot n_ctx, not the training window');
    assert.strictEqual(localContextWindowFor('glm-ocr'), null);
    _resetLocalModelRegistry();
});

// ─── forced tool_choice on llama.cpp ─────────────────────────────────────────
// llama-server reads `tool_choice` as a string (auto | none | required) and
// answers the OpenAI object form with "Wrong type supplied" + auto: 253
// router-journal warnings in three days, every forced call unforced.

const FORCE = { type: 'function', function: { name: 'return_playbook' } };
const T1 = { type: 'function', function: { name: 'return_playbook', parameters: { type: 'object', properties: {} } } };
const T2 = { type: 'function', function: { name: 'other_tool', parameters: { type: 'object', properties: {} } } };

test("llama.cpp never receives an object tool_choice: it becomes 'required'", () => {
    const named = new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], { tools: [T1], toolChoice: FORCE });
    assert.strictEqual(named.tool_choice, 'required');
    assert.deepStrictEqual(named.tools, [T1]);
    // The probe result threaded in by chat()/stream() counts the same as the flavor.
    const probed = new LocalProvider('openai-compatible').buildRequestBody('qwen3-8b', [], { tools: [T1], toolChoice: FORCE, _runtime: 'llamacpp' });
    assert.strictEqual(probed.tool_choice, 'required');
    // The bare {name} shape claude.js also honours is read the same way.
    const bare = new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], { tools: [T1], toolChoice: { name: 'return_playbook' } });
    assert.strictEqual(bare.tool_choice, 'required');
    // The strings pass through untouched.
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], { tools: [T1], toolChoice: 'auto' }).tool_choice, 'auto');
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], { tools: [T1] }).tool_choice, 'auto');
});

test('a multi-tool list with a named tool_choice is narrowed to that tool on llama.cpp, with one warning per name', (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (line) => warned.push(String(line)));
    const p = new LocalProvider('llamacpp');
    const a = p.buildRequestBody('qwen3-8b', [], { tools: [T2, T1], toolChoice: FORCE });
    assert.strictEqual(a.tool_choice, 'required');
    assert.deepStrictEqual(a.tools, [T1], 'required + the one tool === force that tool');
    const b = p.buildRequestBody('qwen3-8b', [], { tools: [T2, T1], toolChoice: FORCE });
    assert.deepStrictEqual(b.tools, [T1]);
    assert.strictEqual(warned.filter(l => /narrowed/.test(l)).length, 1, 'once per tool name, not per request');
    // A name that is not on the list: nothing to narrow to, the menu stays.
    const c = p.buildRequestBody('qwen3-8b', [], { tools: [T2], toolChoice: FORCE });
    assert.strictEqual(c.tool_choice, 'required');
    assert.deepStrictEqual(c.tools, [T2]);
});

test('vLLM, Ollama and a generic endpoint keep the object form — they accept it', () => {
    for (const [flavor, runtime] of [['vllm', undefined], ['ollama', undefined], ['openai-compatible', 'other'], ['sglang', undefined]]) {
        const body = new LocalProvider(flavor).buildRequestBody('Qwen/Qwen3-8B', [], { tools: [T2, T1], toolChoice: FORCE, _runtime: runtime });
        assert.deepStrictEqual(body.tool_choice, FORCE, flavor);
        assert.deepStrictEqual(body.tools, [T2, T1], `${flavor}: list untouched`);
    }
});

// ─── llama.cpp-only request fields ───────────────────────────────────────────

test('cache_prompt rides every llama.cpp request and nothing else', () => {
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], {}).cache_prompt, true);
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('qwen3-8b', [], { stream: true }).cache_prompt, true, 'streamed or not');
    assert.strictEqual(new LocalProvider('openai-compatible').buildRequestBody('qwen3-8b', [], { _runtime: 'llamacpp' }).cache_prompt, true);
    for (const [flavor, runtime] of [['vllm', undefined], ['ollama', undefined], ['lmstudio', undefined], ['openai-compatible', 'other'], ['openai-compatible', undefined]]) {
        const body = new LocalProvider(flavor).buildRequestBody('qwen3-8b', [], { _runtime: runtime });
        assert.strictEqual(body.cache_prompt, undefined, `${flavor}/${runtime}`);
        assert.strictEqual(body.id_slot, undefined);
        assert.strictEqual(body.n_keep, undefined);
    }
});

test('a per-request reasoning budget reaches llama.cpp as reasoning_budget_tokens — only while thinking is on', () => {
    const p = new LocalProvider('llamacpp');
    assert.strictEqual(p.buildRequestBody('qwen3-8b', [], { reasoningEffort: 'medium', budgetTokens: 2048 }).reasoning_budget_tokens, 2048);
    assert.strictEqual(p.buildRequestBody('gemma-4-26b-a4b', [], { reasoningEffort: 'high', budgetTokens: 12288 }).reasoning_budget_tokens, 12288);
    // No budget → the server's own --reasoning-budget flag stays in charge.
    assert.strictEqual(p.buildRequestBody('qwen3-8b', [], { reasoningEffort: 'medium' }).reasoning_budget_tokens, undefined);
    // Thinking off (effort none, or the explicit 0 budget) sends no budget.
    assert.strictEqual(p.buildRequestBody('qwen3-8b', [], { reasoningEffort: 'none', budgetTokens: 2048 }).reasoning_budget_tokens, undefined);
    assert.strictEqual(p.buildRequestBody('qwen3-8b', [], { budgetTokens: 0 }).reasoning_budget_tokens, undefined);
    // No preference at all → nothing about thinking is sent, budget included.
    assert.strictEqual(p.buildRequestBody('qwen3-8b', [], { budgetTokens: 2048 }).reasoning_budget_tokens, undefined);
    // Other runtimes never see the field.
    assert.strictEqual(new LocalProvider('vllm').buildRequestBody('Qwen/Qwen3-8B', [], { reasoningEffort: 'medium', budgetTokens: 2048 }).reasoning_budget_tokens, undefined);
    assert.strictEqual(new LocalProvider('ollama').buildRequestBody('qwen3:8b', [], { reasoningEffort: 'medium', budgetTokens: 2048 }).reasoning_budget_tokens, undefined);
});

// ─── per-family thinking temperature floor ───────────────────────────────────

test('the thinking temperature floor is the family\'s own number — Gemma 4 has none', () => {
    const temp = (model, opts) => new LocalProvider('llamacpp').buildRequestBody(model, [], opts).temperature;
    // Qwen3 / DeepSeek / GLM document ≥ 0.6 for thinking mode.
    assert.strictEqual(temp('qwen3.6-35b-a3b', { temperature: 0.1, reasoningEffort: 'low' }), 0.6);
    assert.strictEqual(temp('deepseek-r1:32b', { temperature: 0.1, reasoningEffort: 'low' }), 0.6);
    assert.strictEqual(temp('glm-4.6', { temperature: 0.1, reasoningEffort: 'low' }), 0.6);
    assert.strictEqual(temp('DeepSeek-V3.1', { temperature: 0.0, reasoningEffort: 'medium' }), 0.6);
    // Gemma 4 publishes no floor: the builder profile's 0.2 (or 0.0) stands, thinking or not.
    assert.strictEqual(temp('gemma-4-26b-a4b', { temperature: 0.2, reasoningEffort: 'medium' }), 0.2);
    assert.strictEqual(temp('gemma-4-26b-a4b', { temperature: 0.0, reasoningEffort: 'high' }), 0.0);
    // A family the table does not list keeps the caller's value too.
    assert.strictEqual(temp('llama3.3:70b', { temperature: 0.1, reasoningEffort: 'low' }), 0.1);
    assert.strictEqual(temp('support-triage:latest', { temperature: 0.1, reasoningEffort: 'low' }), 0.1);
    // The table itself answers the same question.
    const { thinkingMinTemperature } = require('./localModels');
    assert.strictEqual(thinkingMinTemperature('qwen3:8b'), 0.6);
    assert.strictEqual(thinkingMinTemperature('gemma-4-26b-a4b'), null);
    assert.strictEqual(describeLocalModel('qwq:32b').thinkingMinTemperature, 0.6);
    assert.strictEqual(describeLocalModel('gemma3:12b').thinkingMinTemperature, null);
    // Nemotron's reasoning cards publish the same 0.6 (added 2026-09-18, the
    // one family the per-family move had left without its documented floor).
    assert.strictEqual(thinkingMinTemperature('nemotron-3-nano-30b-a3b'), 0.6);
    assert.strictEqual(temp('llama-3.3-nemotron-super-49b', { temperature: 0.1, reasoningEffort: 'medium' }), 0.6);
});

// ─── reasoning replay within a turn ──────────────────────────────────────────
// The builders keep the model's unsigned thinking on the assistant tool-call
// message; llama-server's Gemma 4 template replays `reasoning_content` on
// assistant messages after the last user turn. BaseProvider strips the
// internal `thinking` field, so the mapping has to happen before it.

const THOUGHT = [{ id: 't0', text: 'The table needs a supplier column.' }, { id: 't1', text: 'Then the automation.' }];
const TURN = [
    { role: 'system', content: 'You build apps.' },
    { role: 'user', content: 'Build an invoice tracker.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'app_upsert_table', arguments: '{}' } }], thinking: THOUGHT },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
];

test('reasoning_content is replayed on the assistant tool-call message when the turn thinks on llama.cpp', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', TURN, { reasoningEffort: 'medium' });
    const assistant = body.messages[2];
    assert.strictEqual(assistant.reasoning_content, 'The table needs a supplier column.\nThen the automation.');
    assert.strictEqual(assistant.thinking, undefined, 'the internal field never reaches the wire');
    assert.deepStrictEqual(assistant.tool_calls, TURN[2].tool_calls);
    // The caller's message objects are not mutated.
    assert.deepStrictEqual(TURN[2].thinking, THOUGHT);
    assert.strictEqual(TURN[2].reasoning_content, undefined);
    // The probed generic endpoint behaves the same.
    const probed = new LocalProvider('openai-compatible').buildRequestBody('gemma-4-26b-a4b', TURN, { reasoningEffort: 'medium', _runtime: 'llamacpp' });
    assert.strictEqual(probed.messages[2].reasoning_content, assistant.reasoning_content);
});

test('no replay when the turn does not think, off llama.cpp, before the last user message, or without a tool call', () => {
    const at2 = (flavor, msgs, opts) => new LocalProvider(flavor).buildRequestBody('gemma-4-26b-a4b', msgs, opts).messages[2];
    // Thinking off: carrying reasoning back into a thinking-off round is exactly what the off switch forbids.
    assert.strictEqual(at2('llamacpp', TURN, { reasoningEffort: 'none' }).reasoning_content, undefined);
    assert.strictEqual(at2('llamacpp', TURN, { budgetTokens: 0 }).reasoning_content, undefined);
    // No preference expressed is not "off": the server may be thinking by default.
    assert.strictEqual(at2('llamacpp', TURN, {}).reasoning_content, 'The table needs a supplier column.\nThen the automation.');
    // vLLM / Ollama / a generic endpoint: the field is llama-server's replay contract, not theirs.
    assert.strictEqual(at2('vllm', TURN, { reasoningEffort: 'medium' }).reasoning_content, undefined);
    assert.strictEqual(at2('ollama', TURN, { reasoningEffort: 'medium' }).reasoning_content, undefined);
    assert.strictEqual(at2('openai-compatible', TURN, { reasoningEffort: 'medium', _runtime: 'other' }).reasoning_content, undefined);
    // An earlier turn's reasoning is stale once the person has spoken again.
    const later = [...TURN, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Now add a chart.' }];
    assert.strictEqual(at2('llamacpp', later, { reasoningEffort: 'medium' }).reasoning_content, undefined);
    // Thinking on a plain answer (no tool_calls) is not replayed: nothing follows it in the turn.
    const prose = [TURN[0], TURN[1], { role: 'assistant', content: 'Sure.', thinking: THOUGHT }];
    assert.strictEqual(at2('llamacpp', prose, { reasoningEffort: 'medium' }).reasoning_content, undefined);
    assert.strictEqual(at2('llamacpp', prose, { reasoningEffort: 'medium' }).thinking, undefined);
});

test('signed and redacted thinking parts are never replayed; an existing reasoning_content wins', () => {
    const signed = [TURN[0], TURN[1], { ...TURN[2], thinking: [{ text: 'anthropic', signature: 'sig' }, { text: 'hidden', redacted: true }, { text: 'mine' }] }, TURN[3]];
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', signed, { reasoningEffort: 'medium' }).messages[2].reasoning_content, 'mine');
    const onlySigned = [TURN[0], TURN[1], { ...TURN[2], thinking: [{ text: 'anthropic', signature: 'sig' }] }, TURN[3]];
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', onlySigned, { reasoningEffort: 'medium' }).messages[2].reasoning_content, undefined);
    const preset = [TURN[0], TURN[1], { ...TURN[2], reasoning_content: 'already there' }, TURN[3]];
    assert.strictEqual(new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', preset, { reasoningEffort: 'medium' }).messages[2].reasoning_content, 'already there');
});
