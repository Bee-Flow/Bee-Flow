/**
 * Wire-shape guarantees for the message helpers.
 *
 * Run: cd server && node --test --test-force-exit utils/messageUtils.test.js
 *
 * `stripInternalFields` is the last thing every OpenAI-shaped adapter runs
 * before the SDK call (providers/base.js, providers/openai.js — and through
 * them scaleway, local/vLLM/Ollama, mistral, azure). A `content` the API
 * rejects gets no second chance there: the message sits in the stored history,
 * so the 400 repeats on every later turn and the conversation is unusable.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sanitizeMessages, stripInternalFields, coerceWireContent } = require('./messageUtils');

test('strings, arrays and null pass through untouched', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    assert.strictEqual(coerceWireContent('hello', 'user'), 'hello');
    assert.strictEqual(coerceWireContent(blocks, 'user'), blocks, 'same reference — no needless copy');
    assert.strictEqual(coerceWireContent(null, 'assistant'), null);
    assert.strictEqual(coerceWireContent(undefined, 'assistant'), undefined);
});

test('an object content is flattened to a string instead of reaching the API', () => {
    const out = coerceWireContent({ sent: true, runId: 'run_9f2' }, 'tool');
    assert.strictEqual(typeof out, 'string');
    assert.strictEqual(out, '{"sent":true,"runId":"run_9f2"}');
});

test('numbers and booleans are flattened too', () => {
    assert.strictEqual(coerceWireContent(42, 'user'), '42');
    assert.strictEqual(coerceWireContent(true, 'user'), 'true');
});

test('stripInternalFields never hands an adapter object content', () => {
    const msgs = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Mail ictsupport?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'automation_1', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: { sent: true } },
    ];
    const out = stripInternalFields(msgs);
    for (const m of out) {
        const ok = typeof m.content === 'string' || Array.isArray(m.content) || m.content === null;
        assert.ok(ok, `content of the '${m.role}' message is not wire-legal: ${typeof m.content}`);
    }
    assert.strictEqual(out[3].content, '{"sent":true}');
    assert.strictEqual(out[2].content, null, 'an assistant turn of pure tool_calls keeps its null');
    assert.strictEqual(out[2].tool_calls, msgs[2].tool_calls);
});

test('internal companion fields still come off, and untouched messages keep their identity', () => {
    const plain = { role: 'user', content: 'hi' };
    const rich = { role: 'assistant', content: 'hi', thinking: [{ text: 't' }], attachments: [{ name: 'a.pdf' }], kbSources: [], toolHistory: [], tokenisationInfo: {} };
    const [outPlain, outRich] = stripInternalFields([plain, rich]);
    assert.strictEqual(outPlain, plain, 'nothing to do → same reference');
    for (const f of ['thinking', 'attachments', 'kbSources', 'toolHistory', 'tokenisationInfo']) {
        assert.ok(!(f in outRich), `${f} must not reach the wire`);
    }
    assert.strictEqual(outRich.content, 'hi');
});

test('sanitizeMessages keeps thinking (adapters that replay it read it here)', () => {
    const [out] = sanitizeMessages([{ role: 'assistant', content: 'x', thinking: [{ text: 't', signature: 's' }], parentId: 'p1', id: 'm1' }]);
    assert.deepStrictEqual(out.thinking, [{ text: 't', signature: 's' }]);
    assert.ok(!('parentId' in out) && !('id' in out));
});
