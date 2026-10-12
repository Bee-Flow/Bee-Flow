/**
 * Contract tests — Azure OpenAI adapter on the v1 GA API.
 *
 * Run: node --test core/providers/azure.test.js
 *
 * Pins the Azure-only rules: the v1 base URL whatever the admin pasted, the
 * deployment name on the wire with capabilities taken from the model behind
 * it, the cache and reasoning parameters Azure accepts, and the fallback for a
 * deployment that cannot do the Responses API.
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

let deploymentList = '';
require('./azureDeployments').configureAzureDeployments({ readDeploymentList: async () => deploymentList });

const AzureProvider = require('./azure');
const { toV1BaseUrl, parseDeployments, isResponsesUnsupported } = AzureProvider;

function capture(provider, { responsesError } = {}) {
    const captured = { responsesCalls: 0, completionsCalls: 0 };
    provider.createClient = () => ({
        responses: {
            create: async (params) => {
                captured.responsesCalls++;
                captured.responses = params;
                if (responsesError) throw responsesError;
                return { id: 'r', output: [], output_text: 'ok', usage: {} };
            },
        },
        chat: {
            completions: {
                create: async (params) => {
                    captured.completionsCalls++;
                    captured.completions = params;
                    return { choices: [{ message: { content: 'ok' } }], usage: {} };
                },
            },
        },
    });
    return captured;
}

const MSGS = [{ role: 'user', content: 'hi' }];
const EP = 'https://res.openai.azure.com';

test('every endpoint spelling ends up on /openai/v1', () => {
    for (const ep of [
        'https://res.openai.azure.com',
        'https://res.openai.azure.com/',
        'https://res.openai.azure.com/openai',
        'https://res.openai.azure.com/openai/v1/',
        'https://res.openai.azure.com/openai/deployments/x/chat/completions?api-version=2025-04-01-preview',
    ]) {
        assert.strictEqual(toV1BaseUrl(ep), 'https://res.openai.azure.com/openai/v1', ep);
    }
    assert.strictEqual(toV1BaseUrl('https://res.services.ai.azure.com/'), 'https://res.services.ai.azure.com/openai/v1');
});

test('the real client targets v1 with no api-version, whatever version is stored', () => {
    const azure = new AzureProvider();
    const client = azure.createClient('key', { baseUrl: EP, apiVersion: '2024-04-01-preview' });
    assert.strictEqual(client.baseURL, 'https://res.openai.azure.com/openai/v1');
    assert.strictEqual(client.constructor.name, 'OpenAI', 'not AzureOpenAI, which only knows the dated surface');
});

test('deployment list: plain names and name=model pairs', () => {
    assert.deepStrictEqual(parseDeployments(' prod-chat = gpt-5.6-sol , gpt-4.1,, '), [
        { deployment: 'prod-chat', model: 'gpt-5.6-sol' },
        { deployment: 'gpt-4.1', model: 'gpt-4.1' },
    ]);
});

test('a custom deployment name is sent as-is, with the capabilities of the model behind it', async () => {
    deploymentList = 'prod-chat=gpt-5.6-sol';
    const azure = new AzureProvider();
    const captured = capture(azure);

    await azure.chat('k', EP, 'prod-chat', MSGS, { temperature: 0.7, reasoningEffort: 'high' });

    assert.strictEqual(captured.responses.model, 'prod-chat');
    assert.strictEqual(captured.responses.temperature, undefined, 'gpt-5.6 refuses temperature');
    assert.strictEqual(captured.responses.reasoning.effort, 'high');
    assert.deepStrictEqual(captured.responses.include, ['reasoning.encrypted_content']);
    assert.strictEqual(captured.responses.store, false);
    assert.ok(azure.supportsVision('prod-chat'));
});

test('non-reasoning models go through Responses too, without reasoning params', async () => {
    deploymentList = 'gpt-4.1';
    const azure = new AzureProvider();
    const captured = capture(azure);

    await azure.chat('k', EP, 'gpt-4.1', MSGS, { temperature: 0.2, promptCacheKey: 'conv_1' });

    assert.strictEqual(captured.responsesCalls, 1);
    assert.strictEqual(captured.responses.reasoning, undefined);
    assert.strictEqual(captured.responses.include, undefined);
    assert.strictEqual(captured.responses.temperature, 0.2);
    assert.strictEqual(captured.responses.prompt_cache_key, 'conv_1');
    assert.strictEqual(captured.responses.prompt_cache_retention, '24h', 'gpt-4.1 offers extended retention on Azure');
});

test('azure usage is stamped as azure (billing then looks for the Azure card and can flag an unmapped deployment)', async () => {
    deploymentList = 'prod-chat=gpt-5.6-sol';
    const azure = new AzureProvider();
    azure.createClient = () => ({
        responses: { create: async () => ({ id: 'r', output: [], output_text: 'ok', usage: { input_tokens: 10, output_tokens: 5 } }) },
    });
    const result = await azure.chat('k', EP, 'prod-chat', MSGS, {});
    assert.strictEqual(result.usage.provider_type, 'azure');
    assert.strictEqual(result.usage.prompt_tokens, 10);
    // the stamp survives the normaliser every consumer runs it through
    const { usageLogFields } = require('./usageNormalizer');
    assert.strictEqual(usageLogFields(result.usage).provider_type, 'azure');
    // ...and the billed model is the one behind the deployment
    assert.strictEqual(require('../llm/modelCosts').resolveBilledModel('prod-chat', result.usage.provider_type), 'gpt-5.6-sol');
});

test('cache parameters: 24h only where Azure offers it, never prompt_cache_options', async () => {
    deploymentList = '';
    const azure = new AzureProvider();
    const captured = capture(azure);

    await azure.chat('k', EP, 'gpt-5.6-terra', MSGS, { promptCacheKey: 'c' });
    assert.strictEqual(captured.responses.prompt_cache_retention, undefined, 'deprecated on 5.6+');
    assert.strictEqual(captured.responses.prompt_cache_options, undefined, 'PTU-M rejects it; 30m is the default anyway');

    await azure.chat('k', EP, 'gpt-4.1-mini', MSGS, {});
    assert.strictEqual(captured.responses.prompt_cache_retention, undefined, 'not on the documented list');

    await azure.chat('k', EP, 'gpt-5.2', MSGS, {});
    assert.strictEqual(captured.responses.prompt_cache_retention, '24h');
});

test('tool descriptions are capped at Azure\'s 1,024 characters', async () => {
    deploymentList = '';
    const azure = new AzureProvider();
    const captured = capture(azure);
    const tools = [{ type: 'function', function: { name: 'big', description: 'x'.repeat(5000), parameters: { type: 'object', properties: {} } } }];

    await azure.chat('k', EP, 'gpt-5.6-terra', MSGS, { tools });

    assert.strictEqual(captured.responses.tools[0].description.length, 1024);
    assert.strictEqual(tools[0].function.description.length, 5000, 'caller tools untouched');
});

test('a deployment without Responses support falls back to Chat Completions, once and remembered', async () => {
    deploymentList = 'llama=Llama-4-Maverick';
    const azure = new AzureProvider();
    const err = Object.assign(new Error('400 The model is not supported for the Responses API'), { status: 400 });
    const captured = capture(azure, { responsesError: err });

    const result = await azure.chat('k', EP, 'llama', MSGS, {});
    assert.strictEqual(result.content, 'ok');
    assert.strictEqual(captured.completions.model, 'llama');

    await azure.chat('k', EP, 'llama', MSGS, {});
    assert.strictEqual(captured.responsesCalls, 1, 'not retried on Responses');
    assert.strictEqual(captured.completionsCalls, 2);
});

test('a bad parameter is not mistaken for an unsupported model', () => {
    const bad = Object.assign(new Error("400 Unsupported parameter: 'temperature' is not supported with this model."), { status: 400, param: 'temperature' });
    assert.strictEqual(isResponsesUnsupported(bad), false);
    const busy = Object.assign(new Error('429 model overloaded'), { status: 429 });
    assert.strictEqual(isResponsesUnsupported(busy), false);
});

test('Azure\'s OperationNotSupported wording counts as an unsupported model', () => {
    const msg = '400 The responses operation does not work with the specified model, gpt-35-turbo. Please choose different model and try again.';
    assert.strictEqual(isResponsesUnsupported(Object.assign(new Error(msg), { status: 400, code: 'OperationNotSupported' })), true);
    assert.strictEqual(isResponsesUnsupported(Object.assign(new Error(msg), { status: 400 })), true);
    assert.strictEqual(isResponsesUnsupported(Object.assign(new Error('404 DeploymentNotFound'), { status: 404, code: 'DeploymentNotFound' })), false);
});

test('streaming falls back only before anything was emitted', async () => {
    deploymentList = '';
    const azure = new AzureProvider();
    const err = Object.assign(new Error('400 model not supported'), { status: 400 });
    capture(azure, { responsesError: err });
    azure.createClient = () => ({
        responses: { create: async () => { throw err; } },
        chat: {
            completions: {
                create: async () => (async function* () {
                    yield { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] };
                })(),
            },
        },
    });
    const events = [];
    await azure.stream('k', EP, 'phi-5', MSGS, {}, (type, data) => events.push([type, data]));
    assert.deepStrictEqual(events.map(e => e[0]), ['text', 'done']);
});

test('listModels shows which model sits behind a deployment', async () => {
    deploymentList = 'prod-chat=gpt-5.6-sol, gpt-4.1';
    const models = await new AzureProvider().listModels();
    assert.deepStrictEqual(models, [
        { id: 'prod-chat', name: 'prod-chat (gpt-5.6-sol)' },
        { id: 'gpt-4.1', name: 'gpt-4.1' },
    ]);
});

test('a PDF never reaches Azure Chat Completions; its text still does', async () => {
    deploymentList = '';
    const azure = new AzureProvider();
    const err = Object.assign(new Error('400 model not supported'), { status: 400 });
    const captured = capture(azure, { responsesError: err });
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'invoice text' },
            { type: 'document', title: 'f.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        ],
    }];

    await azure.chat('k', EP, 'phi-5', messages, {});

    assert.deepStrictEqual(captured.completions.messages[0].content, [{ type: 'text', text: 'invoice text' }]);
});

test('a deployment that rejects prompt_cache_retention is retried without it, once and remembered', async () => {
    deploymentList = '';
    const azure = new AzureProvider();
    const seen = [];
    azure.createClient = () => ({
        responses: {
            create: async (params) => {
                seen.push(params.prompt_cache_retention);
                if (params.prompt_cache_retention) {
                    throw Object.assign(new Error("400 Unsupported parameter: 'prompt_cache_retention'"), { status: 400, param: 'prompt_cache_retention' });
                }
                return { id: 'r', output: [], output_text: 'ok', usage: {} };
            },
        },
    });

    const result = await azure.chat('k', EP, 'gpt-4.1', MSGS, {});
    assert.strictEqual(result.content, 'ok');
    assert.deepStrictEqual(seen, ['24h', undefined]);

    await azure.chat('k', EP, 'gpt-4.1', MSGS, {});
    assert.deepStrictEqual(seen, ['24h', undefined, undefined], 'remembered: not tried again');
});
