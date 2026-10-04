/**
 * Contract tests — content parts and images reaching OpenAI / Azure OpenAI.
 *
 * Run: node --test core/providers/openai.content.test.js
 *
 * Both APIs 400 the whole request on a part type or key they do not know, and
 * the offending part stays in history, so the conversation never recovers.
 * And our own storage URLs cannot be fetched by the provider at all.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
mock('../../stores/storageStore', {
    isAvailable: () => true,
    streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'image/png', contentLength: PNG_BYTES.length }),
});

const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
const OpenAIProvider = require('./openai');
const AzureProvider = require('./azure');
const { toResponsesPart, toCompletionsContent } = require('./openaiContent');

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

const PDF_B64 = Buffer.from('%PDF-1.7 fake').toString('base64');

function mixedHistory() {
    return [
        { role: 'system', content: 'be helpful' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'what is in these', cache_control: { type: 'ephemeral' } },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
            ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a cat and a pdf' }] },
        { role: 'user', content: 'thanks' },
    ];
}

test('Responses: every part arrives in its Responses shape, nothing foreign passes through', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);
    await provider.chat('k', null, 'gpt-5.6-terra', mixedHistory(), {});

    const [, user, assistant] = captured.responses.input;
    assert.deepStrictEqual(user.content, [
        { type: 'input_text', text: 'what is in these' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB', detail: 'auto' },
    ]);
    // The assistant's own turn is output; input_text there is a 400.
    assert.deepStrictEqual(assistant.content, [{ type: 'output_text', text: 'a cat and a pdf' }]);
});

test('Chat Completions: the same history becomes text / image_url / file parts', async () => {
    const provider = new OpenAIProvider();
    const captured = capture(provider);
    await provider.chat('k', null, 'gpt-4o', mixedHistory(), { useChatCompletions: true });

    const [, user, assistant] = captured.completions.messages;
    assert.deepStrictEqual(user.content, [
        { type: 'text', text: 'what is in these' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
    ]);
    assert.deepStrictEqual(assistant.content, [{ type: 'text', text: 'a cat and a pdf' }]);
});

test('clean Chat Completions content is handed on untouched', () => {
    const content = [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'low' } }];
    assert.strictEqual(toCompletionsContent(content, 'user'), content);
});

test('an unknown part is dropped rather than sent', () => {
    assert.strictEqual(toResponsesPart({ type: 'video', url: 'x' }, 'user'), null);
    assert.deepStrictEqual(toCompletionsContent([{ type: 'text', text: 'a' }, { type: 'video' }], 'user'), [{ type: 'text', text: 'a' }]);
});

for (const [label, make] of [['OpenAI', () => new OpenAIProvider()], ['Azure', () => new AzureProvider()]]) {
    test(`${label}: our own signed storage URL is sent as bytes, history left alone`, async () => {
        const provider = make();
        const captured = capture(provider);
        const url = generateTempDownloadUrl('users/u1/uploads/upload_1_abcd.png', 900);
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'wat staat hier' }, { type: 'image_url', image_url: { url, detail: 'auto' } }] }];

        await provider.chat('k', 'https://x.openai.azure.com', 'gpt-5.6-terra', messages, {});

        const img = captured.responses.input[0].content[1];
        assert.strictEqual(img.type, 'input_image');
        assert.strictEqual(img.image_url, `data:image/png;base64,${PNG_BYTES.toString('base64')}`);
        assert.ok(messages[0].content[1].image_url.url.includes('/api/storage/tmp/'), 'caller history not rewritten');
    });
}
