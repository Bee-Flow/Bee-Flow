/**
 * The prompt a self-hosted llama.cpp server sees is byte-stable across turns.
 *
 * llama-server caches the prompt as a PREFIX: everything up to the first
 * changed byte is reused, everything after it is re-read at ~150 tok/s on
 * this box. Measured 2026-09-11 with 1.5k system + 1.5k history: with the
 * per-turn block (clock, memories) sitting at index 1 every turn re-read the
 * whole prompt — 4,375 tokens, 28.7 s; with that block folded into the LAST
 * user message only 56-75 tokens (~1 s) were re-read.
 *
 * This test rebuilds three consecutive turns and two tool rounds the way the
 * direct-chat route does — assembly shape, placeVolatileBlock, the local
 * adapter's buildRequestBody — with NO network, and pins the invariant from
 * every side: the stable block never moves, the history is a byte-prefix of
 * the next turn, the clock appears exactly once and last, a same-minute
 * retry is byte-identical, and the pre-fix shape is detectably unstable.
 *
 * Run: cd server && node --test --test-force-exit core/providers/local.prefixStability.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const LocalProvider = require('./local');
const { LATE_SYSTEM_FRAME } = LocalProvider;
const { placeVolatileBlock } = require('../llm/promptLayout');
const { nowLine, formatLocalNow } = require('../llm/clock');
const { systemPrefixFingerprint } = require('../llm/promptCacheStability');

const provider = new LocalProvider('llamacpp');
const TZ = 'Europe/Amsterdam';
const STABLE_TEXT = 'You are Bee Flow.\n\n[TOOLS]\nnotebook_read, notebook_write.\n\n[SKILLS]\nnone active.';
const TOOLS = [
    { type: 'function', function: { name: 'notebook_read', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'notebook_write', parameters: { type: 'object', properties: { content: { type: 'string' } } } } },
];
const OPTIONS = { maxTokens: 1024, temperature: 0.2, reasoningEffort: 'none', tools: TOOLS, toolChoice: 'auto', stream: true };

/** Prompt assembly, as promptAssembly.js does it: fresh objects every turn. */
function assemble({ history, now, memory, userText }) {
    const stable = { role: 'system', content: STABLE_TEXT };
    const volatileMessage = { role: 'system', content: `${nowLine(TZ, { now })}\n\nToday is Friday.\n\n[MEMORY]\n${memory}` };
    const messages = [stable, volatileMessage, ...history.map(m => ({ ...m })), { role: 'user', content: userText }];
    return { messages, volatileMessage };
}
const build = (messages) => provider.buildRequestBody('qwen3-27b', messages, OPTIONS);

const u1 = { role: 'user', content: 'Wat is Bee Flow?' };
const a1 = { role: 'assistant', content: 'Een privacy-first AI-werkplek.' };
const u2 = { role: 'user', content: 'En waar draait het?' };
const a2 = { role: 'assistant', content: 'Self-hosted, in de EU.' };

const T1 = { history: [], now: new Date('2026-09-11T13:04:10Z'), memory: 'User prefers Dutch.', userText: u1.content };
const T2 = { history: [u1, a1], now: new Date('2026-09-11T13:06:40Z'), memory: 'User prefers Dutch.\nUser is based in Utrecht.', userText: u2.content };
const T3 = { history: [u1, a1, u2, a2], now: new Date('2026-09-11T13:09:05Z'), memory: 'User prefers Dutch.\nUser is based in Utrecht.\nUser runs llama.cpp.', userText: 'Hoe snel is het?' };

const layout = (t) => { const { messages, volatileMessage } = assemble(t); placeVolatileBlock(messages, volatileMessage); return { messages, volatileMessage }; };
const countNow = (msgs) => msgs.filter(m => typeof m.content === 'string' && m.content.includes('Now: ')).length;

test('the stable block is byte-identical across three turns', () => {
    const bodies = [T1, T2, T3].map(t => build(layout(t).messages));
    assert.deepStrictEqual(bodies[0].messages[0], bodies[1].messages[0]);
    assert.deepStrictEqual(bodies[1].messages[0], bodies[2].messages[0]);
    const fps = bodies.map(b => systemPrefixFingerprint(b.messages[0].content));
    assert.strictEqual(new Set(fps).size, 1, `fingerprints drift: ${fps.join(' ')}`);
    assert.strictEqual(bodies[0].messages[0].content, STABLE_TEXT, 'nothing was folded INTO the stable block');
});

test('the history is a byte-prefix of the next turn — only the tail is new', () => {
    const t3 = build(layout(T3).messages);
    assert.strictEqual(
        JSON.stringify(t3.messages.slice(0, 3)),
        JSON.stringify([{ role: 'system', content: STABLE_TEXT }, u1, a1]),
    );
    assert.strictEqual(JSON.stringify(t3.messages.slice(3, 5)), JSON.stringify([u2, a2]));
    // t2's whole message list is the prefix of t3's, bar t3's own tail.
    const t2 = build(layout(T2).messages);
    assert.strictEqual(JSON.stringify(t2.messages.slice(0, 3)), JSON.stringify(t3.messages.slice(0, 3)));
});

test('the clock occurs in exactly ONE message, the last, framed, ending with the user text', () => {
    for (const t of [T1, T2, T3]) {
        const body = build(layout(t).messages);
        assert.strictEqual(countNow(body.messages), 1, 'Now: appears once');
        const last = body.messages[body.messages.length - 1];
        assert.strictEqual(last.role, 'user');
        assert.ok(last.content.includes(`Now: ${formatLocalNow(TZ, { now: t.now })}`));
        assert.ok(last.content.startsWith(LATE_SYSTEM_FRAME), 'the folded block is framed as not-from-the-user');
        assert.ok(last.content.endsWith(t.userText), 'the user\'s own words come last');
        assert.ok(last.content.includes(t.memory), 'memories ride the same tail');
    }
    // Only one leading system message ever reaches the template (two hang llama-server).
    const body = build(layout(T3).messages);
    assert.strictEqual(body.messages.filter(m => m.role === 'system').length, 1);
    assert.strictEqual(body.messages[0].role, 'system');
});

test('across tool rounds the previous request is a prefix of the next, with the same tools', () => {
    const { messages, volatileMessage } = layout(T2);
    const r0 = build(messages);
    // Round 1: the model called a tool; the route appends the call and the
    // result and re-runs placement (idempotent) before the follow-up stream.
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'notebook_read', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'call_1', content: '{"content":"…"}' });
    placeVolatileBlock(messages, volatileMessage);
    const r1 = build(messages);

    assert.strictEqual(JSON.stringify(r1.messages.slice(0, r0.messages.length)), JSON.stringify(r0.messages));
    assert.strictEqual(r1.messages.length, r0.messages.length + 2);
    assert.deepStrictEqual(r1.tools, r0.tools);
    assert.strictEqual(JSON.stringify(r1.tools), JSON.stringify(TOOLS));
});

test('a retry within the same minute produces a byte-identical body', () => {
    const a = build(layout({ ...T2, now: new Date('2026-09-11T13:06:02Z') }).messages);
    const b = build(layout({ ...T2, now: new Date('2026-09-11T13:06:59Z') }).messages);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    // The next minute differs — but only in the folded tail.
    const c = build(layout({ ...T2, now: new Date('2026-09-11T13:07:00Z') }).messages);
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(c));
    assert.strictEqual(JSON.stringify(a.messages.slice(0, -1)), JSON.stringify(c.messages.slice(0, -1)));
});

test('the request carries the knobs the raw path used to drop', () => {
    const body = build(layout(T1).messages);
    assert.strictEqual(body.max_tokens, 1024);
    assert.strictEqual(body.reasoning_effort, 'none', 'llama.cpp reads reasoning_effort');
    assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
});

test('inverse guard — a second-resolution clock on the stable block is detectably unstable', () => {
    // If someone re-appends the clock to messages[0], this is what the
    // fingerprint log would show turn after turn: a different prefix.
    const withClock = (iso) => ({ role: 'system', content: `${STABLE_TEXT}\nNow: ${iso}` });
    const a = build([withClock('2026-09-11 15:04:10'), u1]);
    const b = build([withClock('2026-09-11 15:04:11'), u1]);
    assert.notStrictEqual(systemPrefixFingerprint(a.messages[0].content), systemPrefixFingerprint(b.messages[0].content));
    // …and the layout this test protects does not have that problem.
    const c = build(layout(T1).messages);
    const d = build(layout({ ...T1, now: new Date(T1.now.getTime() + 1000) }).messages);
    assert.strictEqual(systemPrefixFingerprint(c.messages[0].content), systemPrefixFingerprint(d.messages[0].content));
});
