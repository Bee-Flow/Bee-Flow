/**
 * Contract tests — OpenAI non-streaming failure surfacing.
 *
 * Run: node --test core/providers/openai.failureSurface.test.js
 *
 * The Responses API reports failure out of band: HTTP 200 with
 * `status: 'failed' | 'incomplete'` and empty output. Returning that as
 * `content: null` read downstream as "the model had nothing to say" and the
 * conversation silently stopped. These pin that such responses THROW (or
 * carry a stopReason when partial output is usable), and that a Chat
 * Completions refusal is surfaced as content rather than swallowed.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('./openai');

const MSGS = [{ role: 'user', content: 'hi' }];

function stubClient(provider, { responses, completions }) {
    provider.createClient = () => ({
        responses: { create: async () => responses },
        chat: { completions: { create: async () => completions } },
    });
}

test("Responses status 'failed' throws with the provider's message", async () => {
    const provider = new OpenAIProvider();
    stubClient(provider, {
        responses: { id: 'r', status: 'failed', error: { message: 'model exploded' }, output: [], usage: {} },
    });
    await assert.rejects(
        provider.chat('k', null, 'gpt-5.6-sol', MSGS, {}),
        /model exploded/,
    );
});

test("Responses 'incomplete' with no output throws a stopReason-tagged error", async () => {
    const provider = new OpenAIProvider();
    stubClient(provider, {
        responses: {
            id: 'r', status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [], output_text: '', usage: {},
        },
    });
    await assert.rejects(
        provider.chat('k', null, 'gpt-5.6-sol', MSGS, {}),
        (err) => {
            assert.match(err.message, /max_output_tokens/);
            assert.strictEqual(err.stopReason, 'max_output_tokens');
            return true;
        },
    );
});

test("Responses 'incomplete' WITH partial output returns it, marked", async () => {
    const provider = new OpenAIProvider();
    stubClient(provider, {
        responses: {
            id: 'r', status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [], output_text: 'half an answer', usage: {},
        },
    });
    const res = await provider.chat('k', null, 'gpt-5.6-sol', MSGS, {});
    assert.strictEqual(res.content, 'half an answer');
    assert.strictEqual(res.stopReason, 'max_output_tokens');
});

test('a completed Responses call reports stopReason null', async () => {
    const provider = new OpenAIProvider();
    stubClient(provider, {
        responses: { id: 'r', status: 'completed', output: [], output_text: 'ok', usage: {} },
    });
    const res = await provider.chat('k', null, 'gpt-5.6-sol', MSGS, {});
    assert.strictEqual(res.content, 'ok');
    assert.strictEqual(res.stopReason, null);
});

test('Chat Completions refusal is returned as content, not swallowed', async () => {
    const provider = new OpenAIProvider();
    stubClient(provider, {
        completions: {
            choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }],
            usage: {},
        },
    });
    const res = await provider.chat('k', null, 'gpt-4o', MSGS, { useChatCompletions: true });
    assert.strictEqual(res.content, "I can't help with that.");
    assert.strictEqual(res.stopReason, 'stop');
});
