/**
 * trimSnapshot — the byte-cap guard on the persisted builder session.
 *
 * Pure: no Postgres. (Requiring the aggregate constructs the pg Pool but does
 * not connect; run with --test-force-exit like the rest of the suite.)
 *
 * What these pin: the guard works on `conversation` (the key the automation
 * builder actually writes — it used to trim `messages`, which the builder never
 * wrote, so it was a no-op that injected `messages: []`), it sheds old tool
 * results before it sheds messages, and when it does drop messages it drops
 * them from the HEAD in multiples of the caller's block so the store's trim
 * lands on the same boundaries as the prompt window (core/llm/historyWindow.js).
 *
 * Run: cd server && node --test --test-force-exit stores/automationStore/builderSessions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { trimSnapshot, SNAPSHOT_MAX_BYTES } = require('./builderSessions');

const BLOCK = 6;
const big = (n, ch = 'r') => ch.repeat(n);

const user = (i, chars = 40) => ({ role: 'user', content: `u${i} ${big(chars, 'u')}` });
const assistant = (i, { resultChars = 0, textChars = 40 } = {}) => ({
    role: 'assistant',
    content: `a${i} ${big(textChars, 'a')}`,
    toolCalls: [{ name: 'builder_add_steps', arguments: { i }, result: { ok: true, echo: big(resultChars) } }],
});
const base = (conversation) => ({
    sessionId: 'bs_x', draft: { trigger: { kind: 'manual' }, steps: [] }, lastValidation: null,
    summary: 's', todos: [{ text: 't', done: false }], catalogOrder: ['memory', 'nextcloud'], conversation,
});
const size = (s) => JSON.stringify(s).length;

test('a snapshot under the cap is returned as-is (same object)', () => {
    const snap = base([user(0), assistant(0, { resultChars: 100 })]);
    assert.ok(size(snap) < SNAPSHOT_MAX_BYTES);
    assert.strictEqual(trimSnapshot(snap, { block: BLOCK }), snap);
    assert.strictEqual(trimSnapshot(null), null);
});

test('over the cap, old tool RESULTS go first — messages and the latest turn are kept whole', () => {
    // 6 exchanges whose results alone are ~10x the cap; the text is tiny, so
    // stripping results from the 5 older assistant turns is enough.
    const conv = [];
    for (let i = 0; i < 6; i++) conv.push(user(i), assistant(i, { resultChars: 20_000 }));
    const snap = base(conv);
    assert.ok(size(snap) > SNAPSHOT_MAX_BYTES);
    const out = trimSnapshot(snap, { block: BLOCK });
    assert.ok(size(out) <= SNAPSHOT_MAX_BYTES, 'fits');
    assert.strictEqual(out.conversation.length, 12, 'no message dropped');
    const last = out.conversation[11];
    assert.ok('result' in last.toolCalls[0], 'the latest assistant turn keeps its tool results (a resume shows it)');
    // Stripping is "oldest first, while over the cap": it stops as soon as the
    // snapshot fits, so the stripped results form a HEAD run and the most
    // recent older turns keep theirs.
    const older = [1, 3, 5, 7, 9].map(i => out.conversation[i]);
    for (const m of older) {
        assert.strictEqual(m.role, 'assistant');
        assert.ok(Array.isArray(m.toolCalls) && m.toolCalls[0].name === 'builder_add_steps', 'the call itself survives pass 1');
    }
    const stripped = older.map(m => !('result' in m.toolCalls[0]));
    const firstKept = stripped.indexOf(false);
    assert.ok(stripped[0], 'the oldest turn lost its result first');
    assert.ok(firstKept === -1 || stripped.slice(firstKept).every(v => v === false), 'stripped turns are a contiguous run from the head');
    assert.strictEqual(stripped.filter(Boolean).length, 3, '3 × 20KB was exactly what it took to fit');
    assert.notStrictEqual(out, snap, 'input not mutated');
    assert.ok('result' in snap.conversation[1].toolCalls[0], 'original untouched');
});

test('still over after results: old tool CALLS go next, then head messages in multiples of the block', () => {
    // Bulk sits in the message TEXT (as if the user pasted documents), so
    // neither result- nor call-stripping can fix it; only dropping messages can.
    const conv = [];
    for (let i = 0; i < 10; i++) conv.push(user(i, 5_000), assistant(i, { resultChars: 10, textChars: 5_000 }));
    const snap = base(conv); // 20 messages ≈ 100KB
    const out = trimSnapshot(snap, { block: BLOCK });
    assert.ok(size(out) <= SNAPSHOT_MAX_BYTES, 'fits');
    const dropped = conv.length - out.conversation.length;
    assert.ok(dropped > 0, 'messages had to go');
    assert.strictEqual(dropped % BLOCK, 0, `dropped ${dropped} — a whole number of blocks, never a ragged head`);
    // What remains is the TAIL of the original (head-eviction), with tool calls
    // stripped from every assistant entry except the last.
    const expected = conv.slice(dropped).map((m, idx, arr) => {
        if (m.role !== 'assistant' || idx === arr.length - 1) return m;
        const { toolCalls, ...rest } = m;
        return rest;
    });
    assert.deepStrictEqual(out.conversation, expected);
    assert.ok('toolCalls' in out.conversation.at(-1), 'latest turn keeps its calls');
});

test('block=1 (the default) still trims one message at a time, oldest first', () => {
    const conv = [];
    for (let i = 0; i < 10; i++) conv.push(user(i, 5_000), assistant(i, { textChars: 5_000 }));
    const out = trimSnapshot(base(conv), { block: 1 });
    assert.ok(size(out) <= SNAPSHOT_MAX_BYTES);
    assert.strictEqual(out.conversation.at(-1).content, conv.at(-1).content, 'tail kept');
    assert.ok(out.conversation.length < conv.length && out.conversation.length >= 3);
    const dflt = trimSnapshot(base(conv));
    assert.deepStrictEqual(dflt.conversation, out.conversation, 'omitting opts = block 1');
});

test('never trims below the latest exchange plus one block', () => {
    // 4 enormous messages, block 6: 4 > 6 + 2 is false → nothing to drop, the
    // snapshot stays oversized rather than losing the latest exchange.
    const conv = [user(0, 30_000), assistant(0, { textChars: 30_000 }), user(1, 30_000), assistant(1, { textChars: 30_000 })];
    const out = trimSnapshot(base(conv), { block: BLOCK });
    assert.strictEqual(out.conversation.length, 4);
});

test('no `messages` key is ever introduced; every other key survives', () => {
    const conv = [];
    for (let i = 0; i < 10; i++) conv.push(user(i, 5_000), assistant(i, { textChars: 5_000 }));
    const snap = base(conv);
    const out = trimSnapshot(snap, { block: BLOCK });
    assert.ok(!('messages' in out), 'the old no-op guard injected messages: [] — must not come back');
    assert.deepStrictEqual(out.catalogOrder, ['memory', 'nextcloud'], 'catalogOrder survives (the next turn replays it)');
    assert.deepStrictEqual(out.todos, snap.todos);
    assert.deepStrictEqual(out.draft, snap.draft);
    assert.strictEqual(out.sessionId, 'bs_x');
    assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(snap).sort(), 'same key set');
});

test('a snapshot with no conversation at all is left alone apart from a normalised empty array', () => {
    const snap = { draft: { steps: [{ blob: big(70_000) }] }, catalogOrder: ['a'] };
    const out = trimSnapshot(snap, { block: BLOCK });
    assert.deepStrictEqual(out.conversation, [], 'nothing to trim — the draft is the bulk and is never touched');
    assert.deepStrictEqual(out.draft, snap.draft);
});
