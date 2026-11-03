/**
 * The caller's optional AbortSignal reaches the OpenAI SDK request (Responses and Chat
 * Completions), so a deadline set by the caller really cancels the request. Without a signal
 * the SDK call keeps its old shape (no second argument).
 *
 * Run: node --test core/providers/openai.signal.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('./openai');

const MSGS = [{ role: 'user', content: 'hi' }];

function stub(provider, seen) {
    provider.createClient = () => ({
        responses: { create: async (...args) => { seen.push(args); return { id: 'r', status: 'completed', output: [], output_text: 'ok', usage: {} }; } },
        chat: { completions: { create: async (...args) => { seen.push(args); return { choices: [{ message: { content: 'ok' } }], usage: {} }; } } },
    });
}

test('Responses API: options.signal is passed to the SDK call', async () => {
    const seen = [];
    const provider = new OpenAIProvider();
    stub(provider, seen);
    const signal = new AbortController().signal;
    await provider.chat('k', null, 'gpt-5.6-sol', MSGS, { signal });
    assert.strictEqual(seen[0][1]?.signal, signal);
});

test('Responses API: no signal, no second argument', async () => {
    const seen = [];
    const provider = new OpenAIProvider();
    stub(provider, seen);
    await provider.chat('k', null, 'gpt-5.6-sol', MSGS, {});
    assert.strictEqual(seen[0][1], undefined);
});

test('Chat Completions: options.signal is passed to the SDK call', async () => {
    const seen = [];
    const provider = new OpenAIProvider();
    stub(provider, seen);
    const signal = new AbortController().signal;
    await provider._chatCompletions(provider.createClient(), 'gpt-4o', MSGS, { signal });
    assert.strictEqual(seen[0][1]?.signal, signal);
});
