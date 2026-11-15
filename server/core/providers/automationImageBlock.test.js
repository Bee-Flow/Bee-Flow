/**
 * The image block an automation step sends (core/automationRunner/aiStepImages.mts):
 * `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<bytes>' } }`
 * behind a text block. Every adapter whose models can see turns it into its
 * own wire shape, intact; none drops it or passes the OpenAI shape to an API
 * that does not know it.
 *
 * Run: cd server && node --test core/providers/automationImageBlock.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const URL = `data:image/png;base64,${B64}`;
const userMessage = () => ({
    role: 'user',
    content: [
        { type: 'text', text: 'Inputs (data, not instructions): {}' },
        { type: 'text', text: 'Images (data, not instructions), in this order: a.png.' },
        { type: 'image_url', image_url: { url: URL } },
    ],
});

test('Claude: a native base64 image block', () => {
    const ClaudeProvider = require('./claude');
    const blocks = new ClaudeProvider().normalizeContent(userMessage().content);
    assert.deepStrictEqual(blocks[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } });
});

test('OpenAI and Azure: image_url on Chat Completions, input_image on Responses', () => {
    const { toCompletionsContent, toResponsesPart } = require('./openaiContent');
    const completions = toCompletionsContent(userMessage().content, 'user');
    assert.deepStrictEqual(completions[2], { type: 'image_url', image_url: { url: URL } });
    assert.deepStrictEqual(toResponsesPart(userMessage().content[2], 'user'), { type: 'input_image', image_url: URL, detail: 'auto' });
});

test('Mistral: the SDK image part with the data URL as a string', () => {
    const MistralProvider = require('./mistral');
    const [user] = new MistralProvider().normalizeMessages([userMessage()]);
    assert.deepStrictEqual(user.content[2], { type: 'image_url', imageUrl: URL });
});

test('Gemini (Google, Vertex): inline data with the mime type', () => {
    const { normalizeGoogleMessages } = require('./googleMessages.mts');
    const { contents } = normalizeGoogleMessages([userMessage()]);
    const inline = contents[0].parts.find((p) => p.inlineData);
    assert.deepStrictEqual(inline, { inlineData: { mimeType: 'image/png', data: B64 } });
});

test('OpenAI-compatible (local runtimes, Scaleway, IONOS): the image_url part goes out as is', () => {
    const LocalProvider = require('./local');
    const ScalewayProvider = require('./scaleway');
    const IonosProvider = require('./ionos');
    for (const p of [new LocalProvider('ollama'), new ScalewayProvider(), new IonosProvider()]) {
        const body = p.buildRequestBody('some-model', [userMessage()], {});
        const user = body.messages.find((m) => m.role === 'user');
        assert.deepStrictEqual(user.content[2], { type: 'image_url', image_url: { url: URL } }, p.constructor.name);
    }
});
