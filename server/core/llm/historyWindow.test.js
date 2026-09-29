/**
 * Head-anchored history window — the property that matters is that the
 * windowed list is a prefix-stable function of the conversation: it grows by
 * appending until a whole block is evicted from the FRONT, and never shifts
 * byte-by-byte the way `.slice(-N)` did.
 *
 * Run: cd server && node --test --test-force-exit core/llm/historyWindow.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { windowHistory, HISTORY_EVICT_BLOCK, DEFAULT_HISTORY_BUDGET_TOKENS } = require('./historyWindow');

// 4 chars/token: a 400-char message ≈ 100 tokens + 4 overhead.
const msg = (role, i, chars = 400) => ({ role, content: `${role}-${i}-`.padEnd(chars, 'x') });
const exchange = (i, chars) => [msg('user', i, chars), msg('assistant', i, chars)];
const convo = (n, chars) => Array.from({ length: n }, (_, i) => exchange(i, chars)).flat();

test('exports the constants the compose site and the store share', () => {
    assert.strictEqual(HISTORY_EVICT_BLOCK, 6);
    assert.strictEqual(DEFAULT_HISTORY_BUDGET_TOKENS, 6000);
});

test('under budget the history comes back identical (and as a copy)', () => {
    const h = convo(4); // 8 × 104 tokens ≈ 832 — far under 6000
    const out = windowHistory(h);
    assert.deepStrictEqual(out, h);
    assert.notStrictEqual(out, h, 'a new array, the input is not aliased');
});

test('eviction drops exactly K-aligned blocks from the HEAD', () => {
    // 20 messages × 104 tokens = 2080. Budget 1000 → need to shed ≥1080 tokens
    // = 11 messages, which rounds UP to two blocks of 6.
    const h = convo(10);
    const out = windowHistory(h, { budgetTokens: 1000, block: 6 });
    assert.deepStrictEqual(out, h.slice(12), 'two whole blocks gone, the rest untouched');
    assert.strictEqual(out.length, 8);
    // One block short of fitting is still one whole block, never 5 or 7.
    const one = windowHistory(h, { budgetTokens: 1500, block: 6 });
    assert.deepStrictEqual(one, h.slice(6));
});

test('never starts with an assistant message', () => {
    // Odd block on an even conversation lands the window on an assistant turn;
    // the window must advance to the next user turn.
    // 20 × 104 = 2080 tokens; budget 1600 sheds exactly one block of 5 (→ 1560).
    const h = convo(10);
    const out = windowHistory(h, { budgetTokens: 1600, block: 5 });
    assert.strictEqual(out[0].role, 'user');
    assert.deepStrictEqual(out, h.slice(6), 'one extra message dropped to reach a user turn');
    // A history that already opens on an assistant message is corrected too.
    const orphan = [msg('assistant', 0), ...convo(2)];
    assert.strictEqual(windowHistory(orphan)[0].role, 'user');
});

test('append-only while nothing is evicted: window(t1) is a prefix of window(t1 + one exchange)', () => {
    const t1 = convo(5);
    const t2 = [...t1, ...exchange(99)];
    const w1 = windowHistory(t1);
    const w2 = windowHistory(t2);
    assert.deepStrictEqual(w2.slice(0, w1.length), w1, 'earlier bytes did not move');
    assert.strictEqual(w2.length, w1.length + 2);
});

test('after an eviction the window start stays put until the next block fills', () => {
    // The sliding-tail behaviour this replaces moved the start on EVERY turn.
    const budget = 1500; // fits ~14 messages of 104 tokens
    const base = convo(8); // 16 messages → one block evicted, window = [6..16)
    const w0 = windowHistory(base, { budgetTokens: budget, block: 6 });
    assert.deepStrictEqual(w0, base.slice(6));
    let h = base;
    // Two more exchanges (20 messages, 2080 tokens): 14 kept ≤ 1500? 14×104 = 1456 → yes,
    // still one block evicted, so the window still starts at index 6.
    for (let i = 0; i < 2; i++) {
        h = [...h, ...exchange(100 + i)];
        const w = windowHistory(h, { budgetTokens: budget, block: 6 });
        assert.deepStrictEqual(w.slice(0, w0.length), w0, `turn ${i + 1}: prefix intact after eviction`);
        assert.strictEqual(w[0], h[6], 'window start pinned to the block boundary');
    }
    // The third exchange tips it over (22 − 6 = 16 × 104 = 1664 > 1500) → next boundary.
    h = [...h, ...exchange(200)];
    const w3 = windowHistory(h, { budgetTokens: budget, block: 6 });
    assert.strictEqual(w3[0], h[12], 'moved exactly one block, not one message');
});

test('deterministic: same input, same output', () => {
    const h = convo(12, 600);
    const a = windowHistory(h, { budgetTokens: 2000 });
    const b = windowHistory(h, { budgetTokens: 2000 });
    assert.deepStrictEqual(a, b);
});

test('a history shorter than one block is never emptied, even over budget', () => {
    const h = convo(2, 20000); // 4 huge messages
    const out = windowHistory(h, { budgetTokens: 100, block: 6 });
    assert.deepStrictEqual(out, h, 'length ≤ block: nothing to evict without losing the whole exchange');
});

test('non-string content and bad input are tolerated', () => {
    assert.deepStrictEqual(windowHistory(null), []);
    assert.deepStrictEqual(windowHistory(undefined), []);
    const h = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: null }];
    assert.deepStrictEqual(windowHistory(h), h);
});
