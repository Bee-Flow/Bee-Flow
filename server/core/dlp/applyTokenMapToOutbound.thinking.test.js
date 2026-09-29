/**
 * Outbound guard — stored REASONING must be re-tokenised too.
 *
 * Run: node --test core/dlp/applyTokenMapToOutbound.thinking.test.js
 *
 * Once the Claude adapter started replaying stored thinking blocks
 * (core/providers/claude.js → replayThinkingBlocks), a second copy of the
 * conversation started flowing to the provider — one the outbound guard did not
 * cover. That matters twice over:
 *
 *   • the model reasoned over a TOKENISED prompt, but persistence restores the
 *     tokens to real values for the UI, so replaying the stored text would push
 *     real personal data to the provider;
 *   • Anthropic signed the tokenised text. Replaying the restored text is a
 *     different string, so signature verification fails and the turn 400s.
 *
 * Re-tokenising fixes both at once — it reconstructs exactly what was signed.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stub the conversation token map before requiring the module ─────────
const runnerPath = require.resolve('./dlpRunner');
const runnerStub = { map: {}, getConversationTokenMap: () => runnerStub.map };
require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true, exports: runnerStub };

const { applyTokenMapToMessages, applyTokenMapToOutbound } = require('./applyTokenMapToOutbound');

const CONV = 'conv-1';
beforeEach(() => { runnerStub.map = { '[email_1]': 'tom@beeflow.nl', '[person_1]': 'Tom Smit' }; });

test('REGRESSION: real values inside replayed thinking are turned back into tokens', () => {
    const out = applyTokenMapToMessages({
        conversationId: CONV,
        messages: [
            { role: 'user', content: 'mail [email_1]' },
            {
                role: 'assistant',
                content: 'Sent it.',
                thinking: [{
                    id: 'p0',
                    signature: 'sig-abc',
                    // What persistence stored after restoring tokens for the UI.
                    text: 'The user wants me to mail Tom Smit at tom@beeflow.nl.',
                }],
            },
        ],
    });

    const part = out[1].thinking[0];
    assert.strictEqual(part.text, 'The user wants me to mail [person_1] at [email_1].');
    assert.ok(!part.text.includes('tom@beeflow.nl'), 'no real personal data may reach the provider');
    assert.strictEqual(part.signature, 'sig-abc', 'the signature rides along untouched');
    assert.strictEqual(out[1].content, 'Sent it.');
});

test('redacted parts and messages without reasoning are left exactly as they are', () => {
    const messages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello', thinking: [{ id: 'p1', redacted: true, redactedData: 'OPAQUE' }] },
        { role: 'assistant', content: 'no reasoning here' },
    ];
    const out = applyTokenMapToMessages({ conversationId: CONV, messages });

    assert.deepStrictEqual(out[1].thinking[0], { id: 'p1', redacted: true, redactedData: 'OPAQUE' });
    assert.strictEqual(out[2].thinking, undefined, 'no empty thinking key is invented');
});

test('an empty token map is a pass-through, reasoning included', () => {
    runnerStub.map = {};
    const messages = [{ role: 'assistant', content: 'a', thinking: [{ id: 'p0', text: 'tom@beeflow.nl' }] }];
    assert.strictEqual(applyTokenMapToMessages({ conversationId: CONV, messages }), messages);
});

test('applyTokenMapToOutbound covers reasoning on the system-prompt path too', () => {
    const { messages } = applyTokenMapToOutbound({
        conversationId: CONV,
        systemPrompt: 'You are helping Tom Smit.',
        messages: [{ role: 'assistant', content: 'ok', thinking: [{ id: 'p0', text: 'reply to tom@beeflow.nl' }] }],
    });
    assert.strictEqual(messages[0].thinking[0].text, 'reply to [email_1]');
});

test('re-running on already-tokenised reasoning changes nothing', () => {
    const messages = [{
        role: 'assistant', content: 'ok',
        thinking: [{ id: 'p0', signature: 's', text: 'mail [email_1] for [person_1]' }],
    }];
    const once = applyTokenMapToMessages({ conversationId: CONV, messages });
    const twice = applyTokenMapToMessages({ conversationId: CONV, messages: once });
    assert.strictEqual(twice[0].thinking[0].text, 'mail [email_1] for [person_1]');
});
