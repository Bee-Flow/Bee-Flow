'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
test.after(require('../testUtils/configRows').useConfigRows().restore);
const OpenAI = require('../core/providers/openai');
const Azure = require('../core/providers/azure');
const Claude = require('../core/providers/claude');
const llm = require('../core/llm/llmClient');
const { configureAzureDeployments } = require('../core/providers/azureDeployments');
const { cleanAiSchema } = require('./canonicalize/aiFields');
const { fieldsToObjectSchema, normalizeSchemaFields, coerceRowToFields } = require('./aiRuntime');

configureAzureDeployments({ readDeploymentList: async () => '' });
const messages = [{ role: 'user', content: 'Read the list.' }];
const answer = { entries: [] };
const tool = (schema) => ({ type: 'function', function: { name: 'record_output', parameters: schema } });
const invalidItems = "400 Invalid schema for response_format 'record_output': In context=('properties', 'entries', 'items'), schema must have a 'type' key.";

function strictResponse(format) {
    if (!format.schema.properties.entries.items?.type) {
        throw Object.assign(new Error(invalidItems), { status: 400 });
    }
    assert.equal(format.strict, true);
    return { choices: [{ message: { content: JSON.stringify(answer) } }] };
}

const fields = [
    { name: 'label', type: 'string', required: true },
    { name: 'count', type: 'number', description: 'Count if known' },
    { name: 'flags', type: 'array', items: { type: 'boolean' } },
];
const objectSchema = {
    type: 'object', additionalProperties: false, required: ['label', 'count', 'flags'],
    properties: {
        label: { type: 'string' },
        count: { type: ['number', 'null'], description: 'Count if known' },
        flags: { type: ['array', 'null'], items: { type: 'boolean' } },
    },
};

for (const [provider, Adapter, model, format] of [
    ['OpenAI Chat Completions', OpenAI, 'gpt-4o', 'completions'],
    ['Azure Chat Completions', Azure, 'gpt-4o', 'completions'],
    ['OpenAI Responses', OpenAI, 'gpt-4o', 'responses'],
    ['Azure Responses', Azure, 'gpt-4o', 'responses'],
    ['Anthropic tool input', Claude, 'claude-sonnet-4-6', 'tool'],
    ['Anthropic native output', Claude, 'claude-sonnet-5', 'native'],
]) {
    test(provider + ' sends typed array items from the saved step schema', async (t) => {
        const adapter = new Adapter();
        let sent;
        const create = async (params) => {
            if (format === 'completions') {
                const responseFormat = params.response_format.json_schema;
                sent = responseFormat.schema;
                return strictResponse(responseFormat);
            }
            if (format === 'responses') {
                sent = params.text.format.schema;
                assert.equal(params.text.format.strict, true);
                return { output_text: JSON.stringify(answer), output: [] };
            }
            if (format === 'tool') {
                sent = params.tools[0].input_schema;
                return { content: [{ type: 'tool_use', name: 'record_output', id: 'r', input: answer }] };
            }
            sent = params.output_config.format.schema;
            return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
        };
        adapter.createClient = () => ({ chat: { completions: { create } }, responses: { create }, messages: { create } });
        t.mock.method(llm, '_resolve', async () => ({ apiKey: 'test', adapter }));
        for (const [items, expected] of [
            [undefined, { type: 'string' }],
            [{ type: 'string' }, { type: 'string' }],
            [{ type: 'number' }, { type: 'number' }],
            [{ type: 'boolean' }, { type: 'boolean' }],
            [{ type: 'object', fields }, objectSchema],
        ]) {
            const schema = [{ name: 'entries', type: 'array', required: true, ...(items && { items }) }];
            const saved = cleanAiSchema(schema, 'schema');
            assert.deepEqual(saved, schema);
            const parameters = fieldsToObjectSchema(normalizeSchemaFields(saved));
            const result = await llm.chatForcedTool(model, messages, tool(parameters), { useChatCompletions: format === 'completions' });
            assert.deepEqual(sent.properties.entries, { type: 'array', items: expected });
            assert.deepEqual(result.structured, answer);
        }
    });
}

test('Azure rejects the former empty items schema with the reported 400 and accepts a saved legacy field', async () => {
    const adapter = new Azure();
    adapter.createClient = () => ({ chat: { completions: { create: async (params) => strictResponse(params.response_format.json_schema) } } });
    const send = (schema) => adapter.chat('test', undefined, 'gpt-4o', messages, {
        useChatCompletions: true, responseFormat: { type: 'json_schema', json_schema: { name: 'record_output', schema } },
    });
    const fixed = fieldsToObjectSchema([{ name: 'entries', type: 'array', required: true }]);
    const former = { ...fixed, properties: { entries: { type: 'array', items: {} } } };
    await assert.rejects(send(former), { message: invalidItems, status: 400 });
    assert.deepEqual(JSON.parse((await send(fixed)).content), answer);
});

test('a non-strict tool answer is coerced against explicitly declared object fields', () => {
    const schema = normalizeSchemaFields([{ name: 'entries', type: 'array', items: { type: 'object', fields } }]);
    const row = { entries: [{ label: 123, flags: ['yes', false], extra: true }] };
    assert.deepEqual(coerceRowToFields(row, schema), { entries: [{ label: '123', count: null, flags: [true, false] }] });
});
