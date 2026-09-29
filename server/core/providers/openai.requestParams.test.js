/**
 * Contract tests — OpenAI request body construction.
 *
 * Run: node --test core/providers/openai.requestParams.test.js
 *
 * These pin the parameter rules that are a hard 400 when they are wrong:
 * temperature on a model that refuses it, the per-generation prompt-cache TTL
 * parameter, and `strict` on a schema that cannot satisfy structured outputs.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('./openai');

function capture(provider) {
    const captured = {};
    provider.createClient = () => ({
        responses: {
            create: async (params) => {
                captured.responses = params;
                return { id: 'r', output: [], output_text: 'ok', usage: {} };
            },
        },
        chat: {
            completions: {
                create: async (params) => {
                    captured.completions = params;
                    return { choices: [{ message: { content: 'ok' } }], usage: {} };
                },
            },
        },
    });
    return captured;
}

const MSGS = [{ role: 'user', content: 'hi' }];

test('temperature is withheld from models that refuse it', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-6-astra', MSGS, { temperature: 0.7 });
    assert.strictEqual(captured.responses.temperature, undefined, 'gpt-6 rejects temperature outright');

    await provider.chat('k', null, 'gpt-5.6-luna', MSGS, { temperature: 0.7 });
    assert.strictEqual(captured.responses.temperature, undefined);

    await provider.chat('k', null, 'gpt-4o', MSGS, { temperature: 0.7, useChatCompletions: true });
    assert.strictEqual(captured.completions.temperature, 0.7, 'gpt-4o still takes it');
});

test('the Responses path caps output with max_output_tokens', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-5.6-terra', MSGS, { maxTokens: 4096 });
    assert.strictEqual(captured.responses.max_output_tokens, 4096);
    assert.strictEqual(captured.responses.max_completion_tokens, undefined);

    await provider.chat('k', null, 'gpt-4o', MSGS, { maxTokens: 4096, useChatCompletions: true });
    assert.strictEqual(captured.completions.max_completion_tokens, 4096);
});

test('the prompt-cache TTL parameter follows the model generation', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-5.6-sol', MSGS, { promptCacheKey: 'conv_1' });
    assert.deepStrictEqual(captured.responses.prompt_cache_options, { ttl: '30m' });
    assert.strictEqual(captured.responses.prompt_cache_retention, undefined);
    assert.strictEqual(captured.responses.prompt_cache_key, 'conv_1');

    // Older models get NEITHER: their retention already defaults to 24h, and
    // every extra parameter is another thing an older surface can reject.
    await provider.chat('k', null, 'gpt-5.2', MSGS, {});
    assert.strictEqual(captured.responses.prompt_cache_retention, undefined);
    assert.strictEqual(captured.responses.prompt_cache_options, undefined);

    // Unless a caller asks for one explicitly.
    await provider.chat('k', null, 'gpt-5.2', MSGS, { promptCacheRetention: 'in_memory' });
    assert.strictEqual(captured.responses.prompt_cache_retention, 'in_memory');
});

test('no reasoning param is sent to a model that takes none', async () => {
    // Reachable now that Responses is the default for every model.
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-4o', MSGS, { reasoningEffort: 'medium' });
    assert.strictEqual(captured.responses.reasoning, undefined);

    await provider.chat('k', null, 'gpt-6-astra', MSGS, { reasoningEffort: 'max' });
    assert.deepStrictEqual(captured.responses.reasoning, { effort: 'max' });
});

test('strict is set only on schemas that satisfy structured outputs', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-5.6-terra', MSGS, {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'tight',
                    parameters: {
                        type: 'object',
                        properties: { a: { type: 'string' } },
                        required: ['a'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'loose',
                    parameters: {
                        type: 'object',
                        properties: { a: { type: 'string' }, b: { type: 'string' } },
                        required: ['a'],
                    },
                },
            },
        ],
    });

    const [tight, loose] = captured.responses.tools;
    assert.strictEqual(tight.name, 'tight');
    assert.strictEqual(tight.strict, true);
    assert.strictEqual(loose.strict, false, 'a schema that cannot be strict says so, rather than staying silent');
    // Responses tools are flat — no `function:{}` wrapper.
    assert.strictEqual(tight.function, undefined);
    assert.ok(tight.parameters);
});

test('native structured output goes to text.format on Responses', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);
    const schema = {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
    };

    await provider.chat('k', null, 'gpt-5.6-terra', MSGS, {
        responseFormat: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    });
    assert.deepStrictEqual(captured.responses.text.format, {
        type: 'json_schema', name: 'reply', schema, strict: true,
    });

    await provider.chat('k', null, 'gpt-4o', MSGS, {
        useChatCompletions: true,
        responseFormat: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    });
    assert.strictEqual(captured.completions.response_format.type, 'json_schema');
    assert.strictEqual(captured.completions.response_format.json_schema.name, 'reply');
});

test('extraBody reaches the request, as it does on every other adapter', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-4o', MSGS, {
        useChatCompletions: true,
        extraBody: { response_format: { type: 'json_object' } },
    });
    assert.deepStrictEqual(captured.completions.response_format, { type: 'json_object' });
});

test('a custom baseUrl is honoured (EU regional processing, proxies)', async () => {
    const provider = new OpenAIProvider();
    let seen = null;
    const OpenAI = require('openai');
    // Exercise the real client constructor rather than the capture stub.
    const client = provider.createClient('k', { baseUrl: 'https://eu.api.openai.com/v1' });
    assert.ok(client instanceof OpenAI);
    seen = client.baseURL;
    assert.strictEqual(seen, 'https://eu.api.openai.com/v1');

    const dflt = provider.createClient('k', {});
    assert.strictEqual(dflt.baseURL, 'https://api.openai.com/v1');
});

test('Azure inherits everything except the prompt-cache TTL parameters', async () => {
    // Azure pins its surface to an api-version and 400s on parameters that
    // version does not know. It sent neither TTL parameter before this change,
    // and must keep not sending them.
    const AzureProvider = require('./azure');
    const azure = new AzureProvider();
    const captured = capture(azure);

    await azure.chat('k', 'https://x.openai.azure.com', 'gpt-5.6-terra', MSGS, { promptCacheKey: 'conv_1' });
    assert.strictEqual(captured.responses.prompt_cache_key, 'conv_1', 'the cache-routing hint still goes');
    assert.strictEqual(captured.responses.prompt_cache_options, undefined);
    assert.strictEqual(captured.responses.prompt_cache_retention, undefined);
    // And Azure keeps its stateless contract.
    assert.strictEqual(captured.responses.store, false);
});

test('a forced tool reaches each API in that API\'s own shape', async () => {
    // Callers build the Chat Completions shape (llmClient.forcedToolChoice).
    // Responses needs it flat, or it answers
    // `400 Missing required parameter: 'tool_choice.name'` — which is what
    // killed a Studio Playbook phase.
    const provider = new OpenAIProvider();
    const captured = capture(provider);
    const tools = [{ type: 'function', function: { name: 'emit', parameters: { type: 'object', properties: {} } } }];
    const forced = { type: 'function', function: { name: 'emit' } };

    await provider.chat('k', null, 'gpt-6-astra', MSGS, { tools, toolChoice: forced });
    assert.deepStrictEqual(captured.responses.tool_choice, { type: 'function', name: 'emit' });

    await provider.chat('k', null, 'gpt-4o', MSGS, { tools, toolChoice: forced, useChatCompletions: true });
    assert.deepStrictEqual(captured.completions.tool_choice, { type: 'function', function: { name: 'emit' } });
});

test('strict is stated explicitly, never left to the default', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);

    await provider.chat('k', null, 'gpt-6-astra', MSGS, {
        tools: [{ type: 'function', function: { name: 'loose', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }],
    });
    // Responses attempts strict mode by default; a schema that cannot satisfy
    // it must say so rather than stay silent.
    assert.strictEqual(captured.responses.tools[0].strict, false);
});
