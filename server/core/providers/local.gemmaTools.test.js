/**
 * Gemma 4 gets tool schemas its chat template can render; nobody else is touched.
 *
 * The local adapter projects `options.tools` through
 * core/llm/toolSchemaProjection when the model's family is Gemma 4 — on any
 * runtime, since the template is the model's, not the server's. Every other
 * family gets the caller's list by reference (a byte-stable prefix for the
 * cloud-style callers), and `extraBody.tools` still wins over both.
 *
 * Run: cd server && node --test --test-force-exit core/providers/local.gemmaTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const LocalProvider = require('./local');

const NOISY_TOOL = {
    type: 'function',
    function: {
        name: 'app_bind_action',
        description: 'Bind an action',
        parameters: {
            type: 'object',
            title: 'BindAction',
            properties: {
                actionId: { type: ['string', 'null'], description: 'null clears the binding' },
                format: { type: 'string', enum: ['pdf', 'docx'], default: 'pdf' },
                items: { type: 'array', items: { type: 'string', pattern: '^x' }, maxItems: 8 },
            },
            required: ['actionId'],
            additionalProperties: false,
        },
    },
};
const CLEAN_TOOL = {
    type: 'function',
    function: { name: 'app_set_meta', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
};

test('a Gemma 4 model receives projected copies: the null union lifted, the invisible keywords gone, names kept', () => {
    for (const flavor of ['llamacpp', 'openai-compatible', 'vllm', 'ollama']) {
        const body = new LocalProvider(flavor).buildRequestBody('gemma-4-26b-a4b', [], { tools: [NOISY_TOOL, CLEAN_TOOL], toolChoice: 'auto' });
        const params = body.tools[0].function.parameters;
        assert.notStrictEqual(body.tools, undefined, flavor);
        assert.notStrictEqual(body.tools[0], NOISY_TOOL, `${flavor}: a copy`);
        assert.strictEqual(params.title, undefined, flavor);
        // Lifted to the two keys the template renders and nothing else — no
        // anyOf: nothing on llama.cpp reads it and the template leaks it
        // (core/llm/toolSchemaProjection, module header).
        assert.deepStrictEqual(params.properties.actionId, { type: 'string', description: 'null clears the binding', nullable: true });
        // `format` is a property NAME here and survives; its `default` node keyword does not.
        assert.deepStrictEqual(params.properties.format, { type: 'string', enum: ['pdf', 'docx'] });
        assert.deepStrictEqual(params.properties.items, { type: 'array', items: { type: 'string' } });
        assert.strictEqual(params.additionalProperties, false, 'left alone on purpose');
        assert.deepStrictEqual(params.required, ['actionId']);
        assert.deepStrictEqual(body.tools.map(t => t.function.name), ['app_bind_action', 'app_set_meta']);
    }
    // The caller's schema was never mutated.
    assert.deepStrictEqual(NOISY_TOOL.function.parameters.properties.actionId.type, ['string', 'null']);
    assert.strictEqual(NOISY_TOOL.function.parameters.title, 'BindAction');
});

test('every other family gets the tool list by reference — untouched', () => {
    for (const model of ['qwen3.6-35b-a3b', 'gemma3:12b', 'deepseek-r1:32b', 'llama3.3:70b', 'support-triage:latest']) {
        const tools = [NOISY_TOOL, CLEAN_TOOL];
        const body = new LocalProvider('llamacpp').buildRequestBody(model, [], { tools, toolChoice: 'auto' });
        assert.strictEqual(body.tools, tools, model);
        assert.deepStrictEqual(body.tools[0].function.parameters.properties.actionId.type, ['string', 'null'], model);
    }
});

test('no tools, an empty list, or extraBody.tools: the projection stays out of the way', () => {
    const p = new LocalProvider('llamacpp');
    assert.strictEqual(p.buildRequestBody('gemma-4-26b-a4b', [], {}).tools, undefined);
    assert.strictEqual(p.buildRequestBody('gemma-4-26b-a4b', [], { tools: [] }).tools, undefined);
    const override = [{ type: 'function', function: { name: 'mine', parameters: { type: 'object', title: 'kept' } } }];
    const body = p.buildRequestBody('gemma-4-26b-a4b', [], { tools: [NOISY_TOOL], extraBody: { tools: override } });
    assert.strictEqual(body.tools, override, 'extraBody wins, verbatim');
    assert.strictEqual(body.tools[0].function.parameters.title, 'kept');
});

test('the forced-choice narrowing on llama.cpp works on the projected list', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', [], {
        tools: [NOISY_TOOL, CLEAN_TOOL],
        toolChoice: { type: 'function', function: { name: 'app_set_meta' } },
    });
    assert.strictEqual(body.tool_choice, 'required');
    assert.strictEqual(body.tools.length, 1);
    assert.strictEqual(body.tools[0].function.name, 'app_set_meta');
});

// ─── A forced tool on llama.cpp: grammar-enforced JSON, not a native call ───

test('forcedTool on llama.cpp: the tool stays on the list (declaration rendered), tool_choice is none and response_format carries the schema as json_schema', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', [{ role: 'user', content: 'x' }], {
        tools: [CLEAN_TOOL], toolChoice: 'required', forcedTool: CLEAN_TOOL,
    });
    assert.strictEqual(body.tool_choice, 'none');
    assert.strictEqual(body.tools.length, 1);
    assert.strictEqual(body.tools[0].function.name, 'app_set_meta');
    assert.deepStrictEqual(body.response_format, {
        type: 'json_schema',
        json_schema: { name: 'app_set_meta', schema: CLEAN_TOOL.function.parameters },
    });
    // The rendered declaration is the projected copy on Gemma; the grammar gets the caller's schema as-is.
    const noisy = new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', [], { tools: [NOISY_TOOL], toolChoice: 'required', forcedTool: NOISY_TOOL });
    assert.strictEqual(noisy.response_format.json_schema.schema, NOISY_TOOL.function.parameters);
    assert.notStrictEqual(noisy.tools[0], NOISY_TOOL, 'declaration projected for the template');
});

test('forcedTool is ignored off llama.cpp (vLLM keeps the tool route) and without a parameter schema', () => {
    const vllm = new LocalProvider('vllm').buildRequestBody('qwen3-8b', [], { tools: [CLEAN_TOOL], toolChoice: 'required', forcedTool: CLEAN_TOOL });
    assert.strictEqual(vllm.tool_choice, 'required');
    assert.strictEqual(vllm.response_format, undefined);
    const bare = { type: 'function', function: { name: 'ping' } };
    const noSchema = new LocalProvider('llamacpp').buildRequestBody('gemma-4-26b-a4b', [], { tools: [bare], toolChoice: 'required', forcedTool: bare });
    assert.strictEqual(noSchema.tool_choice, 'required');
    assert.strictEqual(noSchema.response_format, undefined);
});

test('a reply llama-server discarded as unparsable (the PEG 500) is asked for once more; a second one, or any other 500, is the caller\'s', async (t) => {
    const pegError = JSON.stringify({ error: { code: 500, message: 'The model produced output that does not match the expected peg-gemma4 format', type: 'server_error' } });
    let n = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (/\/props(\?|$)/.test(String(url))) return new Response(JSON.stringify({ build_info: 'b1', default_generation_settings: { n_ctx: 65536 } }), { status: 200 });
        n += 1;
        if (n === 1) return new Response(pegError, { status: 500 });
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
    });
    const out = await new LocalProvider('llamacpp').chat('', 'http://box:8080/v1', 'gemma-4-26b-a4b', [{ role: 'user', content: 'x' }], {});
    assert.strictEqual(n, 2, 'one retry');
    assert.strictEqual(out.content, '{"ok":true}');

    n = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (/\/props(\?|$)/.test(String(url))) return new Response(JSON.stringify({ build_info: 'b1', default_generation_settings: { n_ctx: 65536 } }), { status: 200 });
        n += 1;
        return new Response(pegError, { status: 500 });
    });
    await assert.rejects(() => new LocalProvider('llamacpp').chat('', 'http://box2:8080/v1', 'gemma-4-26b-a4b', [{ role: 'user', content: 'x' }], {}), /does not match the expected/);
    assert.strictEqual(n, 2, 'exactly one retry, then the error');

    n = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (/\/props(\?|$)/.test(String(url))) return new Response(JSON.stringify({ build_info: 'b1', default_generation_settings: { n_ctx: 65536 } }), { status: 200 });
        n += 1;
        return new Response('{"error":{"message":"out of memory"}}', { status: 500 });
    });
    await assert.rejects(() => new LocalProvider('llamacpp').chat('', 'http://box3:8080/v1', 'gemma-4-26b-a4b', [{ role: 'user', content: 'x' }], {}), /out of memory/);
    assert.strictEqual(n, 1, 'other errors are not retried here');
});
