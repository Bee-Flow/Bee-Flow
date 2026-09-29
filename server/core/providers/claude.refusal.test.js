/**
 * Unit tests — `stop_reason: 'refusal'` and `model_context_window_exceeded`.
 *
 * Run: node --test core/providers/claude.refusal.test.js
 *
 * Claude Opus 5 and the Fable/Mythos family run safety classifiers that can
 * DECLINE a request. A decline is NOT an error and does not throw: the API
 * answers HTTP 200 with `stop_reason: 'refusal'`, a structured `stop_details`
 * category, and NO text content.
 *
 * The adapter used to read content blocks without ever checking stop_reason, so
 * a declined request returned `content: null` — which downstream reads as "the
 * model had nothing to say". The user saw a blank answer, no error, no reason.
 * In the streaming path it was worse: no text events, so the UI simply stopped.
 *
 * `stop_details` is populated ONLY for a refusal (null for end_turn, max_tokens,
 * tool_use, …), so every read of it must be guarded.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');

const MSGS = [{ role: 'user', content: 'hello' }];

function clientReturning(message) {
    return {
        messages: {
            create: async () => message,
            stream: () => {
                const events = (async function* () {})();
                events.finalMessage = async () => message;
                return events;
            },
        },
    };
}

function refusal(category, explanation) {
    return {
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category, explanation },
        usage: { input_tokens: 10, output_tokens: 0 },
    };
}

test('chat() turns a refusal into words instead of a null answer', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning(refusal('cyber', null));

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.strictEqual(res.stopReason, 'refusal');
    assert.ok(res.content, 'a refusal must not surface as an empty answer');
    assert.match(res.content, /declined/i);
    assert.match(res.content, /security or exploitation/i, 'the category should be explained');
    assert.deepStrictEqual(res.stopDetails, { type: 'refusal', category: 'cyber', explanation: null });
});

test('an unknown refusal category still produces a usable message', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    // `category` is an open set — a value we have never seen must not crash or
    // produce a half-built sentence.
    p.createClient = () => clientReturning(refusal('some_future_category', null));

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.ok(res.content && res.content.length > 0);
    assert.match(res.content, /declined/i);
    assert.ok(!/undefined|null/.test(res.content), `leaked a placeholder: ${res.content}`);
});

test('a refusal explanation from the API is passed through', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning(refusal('bio', 'Specifics were withheld.'));

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.match(res.content, /Specifics were withheld\./);
});

test('stop_details is null on an ordinary turn and is not invented', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning({
        content: [{ type: 'text', text: 'the real answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
    });

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.strictEqual(res.content, 'the real answer');
    assert.strictEqual(res.stopReason, 'end_turn');
    assert.strictEqual(res.stopDetails, null);
});

test('a refusal never overwrites text the model did emit', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    // A mid-stream decline can carry partial text. That text is what the user
    // should see — the canned message is only for the empty case.
    p.createClient = () => clientReturning({
        content: [{ type: 'text', text: 'partial answer before the decline' }],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        usage: { input_tokens: 1, output_tokens: 5 },
    });

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.strictEqual(res.content, 'partial answer before the decline');
    assert.strictEqual(res.stopReason, 'refusal');
});

test('model_context_window_exceeded is reported distinctly from a refusal', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning({
        content: [],
        stop_reason: 'model_context_window_exceeded',
        usage: { input_tokens: 999999, output_tokens: 0 },
    });

    const res = await p.chat('k', null, 'claude-opus-5', MSGS, {});
    assert.strictEqual(res.stopReason, 'model_context_window_exceeded');
    assert.match(res.content, /context window/i);
    assert.ok(!/declined/i.test(res.content), 'must not be reported as a refusal');
});

test('stream() emits refusal text instead of ending silently', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning(refusal('cyber', null));

    const events = [];
    await p.stream('k', null, 'claude-opus-5', MSGS, {}, (type, data) => events.push({ type, data }));

    const text = events.filter((e) => e.type === 'text').map((e) => e.data.text).join('');
    assert.match(text, /declined/i, 'a refused stream must say something');

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'stream must still complete');
    assert.strictEqual(done.data.stopReason, 'refusal');
    assert.strictEqual(done.data.stopDetails.category, 'cyber');
});

test('stream() reports stopReason on an ordinary turn too', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    p.createClient = () => clientReturning({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
    });

    const events = [];
    await p.stream('k', null, 'claude-opus-5', MSGS, {}, (type, data) => events.push({ type, data }));
    const done = events.find((e) => e.type === 'done');
    assert.strictEqual(done.data.stopReason, 'end_turn');
    assert.strictEqual(done.data.stopDetails, null);
});
