/**
 * Local adapter — system messages are folded into a template-safe shape.
 *
 * REGRESSION (2026-09-11): after switching the demo box to Qwen3.8-27B every
 * builder turn died with a 400 from llama-server — "System message must be at
 * the beginning" — because the builder sends its live draft state as a second
 * system message placed late (deliberately, for Claude/OpenAI prefix caching).
 * Two LEADING system messages hung the request outright. Normal chat, which
 * sends exactly one leading system message, kept working, which is why it
 * looked like "the builder is broken" rather than "the template is strict".
 *
 * Run: cd server && node --test --test-force-exit core/providers/local.systemFold.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const LocalProvider = require('./local');
const { foldLateSystemMessages, LATE_SYSTEM_FRAME } = LocalProvider;

const roles = (ms) => ms.map(m => m.role).join(',');

test('the common shape — one system message, first — passes through untouched', () => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
    assert.strictEqual(foldLateSystemMessages(msgs), msgs, 'same reference: nothing to do');
});

test('the builder shape: a late system message rides on the next user message', () => {
    const out = foldLateSystemMessages([
        { role: 'system', content: 'static prompt' },
        { role: 'user', content: 'earlier turn' },
        { role: 'assistant', content: 'ok' },
        { role: 'system', content: '## Current draft — LIVE state' },
        { role: 'user', content: 'add a notification' },
    ]);
    assert.strictEqual(roles(out), 'system,user,assistant,user');
    assert.strictEqual(out[0].content, 'static prompt', 'the cached static prompt is byte-identical');
    assert.ok(out[3].content.startsWith(LATE_SYSTEM_FRAME), 'the folded block is framed as not-from-the-user');
    assert.ok(out[3].content.includes('## Current draft — LIVE state'));
    assert.ok(out[3].content.endsWith('add a notification'), 'the user\'s own words come last');
});

test('two leading system messages — the shape that hung llama-server — leave ONE, the second rides the user turn', () => {
    // Merging them into one system message was the first fix. It kept the
    // template happy but changed block 0 on the first turn of every chat
    // (`[stable, volatile, user]` before any history exists), so turn 1 could
    // never share a cached prefix with turn 2. Folding the second one forward
    // gives the template a single system message AND a byte-stable block 0.
    const out = foldLateSystemMessages([
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'u' },
    ]);
    assert.strictEqual(roles(out), 'system,user');
    assert.strictEqual(out[0].content, 'A', 'block 0 is exactly the first system message');
    assert.ok(out[1].content.startsWith(LATE_SYSTEM_FRAME));
    assert.ok(out[1].content.includes('B'));
    assert.ok(out[1].content.endsWith('u'));
});

test('two leading system messages with no user turn at all: the second becomes its own user turn', () => {
    const out = foldLateSystemMessages([
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
    ]);
    assert.strictEqual(roles(out), 'system,user');
    assert.strictEqual(out[0].content, 'A');
    assert.ok(out[1].content.includes('B'));
});

test('a late system message with no user message after it becomes its own user turn', () => {
    const out = foldLateSystemMessages([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u' },
        { role: 'system', content: 'late' },
        { role: 'assistant', content: 'a' },
    ]);
    assert.strictEqual(roles(out), 'system,user,user,assistant');
    assert.ok(out[2].content.includes('late'));
});

test('a multimodal user turn keeps its parts and gains the folded text as the first part', () => {
    const out = foldLateSystemMessages([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u' },
        { role: 'system', content: 'ctx' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:…' } }, { type: 'text', text: 'what is this?' }] },
    ]);
    const last = out[out.length - 1];
    assert.ok(Array.isArray(last.content));
    assert.strictEqual(last.content[0].type, 'text');
    assert.ok(last.content[0].text.includes('ctx'));
    assert.strictEqual(last.content.length, 3);
});

test('array-shaped system content is flattened to text when folded', () => {
    const out = foldLateSystemMessages([
        { role: 'system', content: [{ type: 'text', text: 'A' }] },
        { role: 'system', content: [{ type: 'text', text: 'B' }, { type: 'text', text: 'C' }] },
        { role: 'user', content: 'u' },
    ]);
    // The leading block passes through untouched — the same treatment the
    // single-system shape always had — so block 0 stays byte-stable.
    assert.deepStrictEqual(out[0].content, [{ type: 'text', text: 'A' }]);
    assert.strictEqual(out[1].content, `${LATE_SYSTEM_FRAME}\nB\nC\n\nu`);
});

test('buildRequestBody applies the fold for every local runtime, and tool messages are left alone', () => {
    const msgs = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' },
        { role: 'system', content: 'draft state' },
        { role: 'user', content: 'next' },
    ];
    for (const flavor of ['llamacpp', 'ollama', 'vllm', 'lmstudio']) {
        const body = new LocalProvider(flavor).buildRequestBody('qwen3.8-27b', msgs, {});
        assert.strictEqual(roles(body.messages), 'system,user,assistant,tool,user', flavor);
        assert.ok(body.messages[4].content.includes('draft state'), flavor);
        assert.strictEqual(body.messages[3].tool_call_id, 't1', flavor);
    }
});
