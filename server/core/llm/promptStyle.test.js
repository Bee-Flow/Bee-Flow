/**
 * BFSF-261 — writing-style prompt addendum.
 *
 * Pins the content (space-after-punctuation rule, em-dash avoidance, the hard
 * Dutch rule) and byte-stability across calls — both prompt builders append
 * it inside the cacheable prefix, so any per-call variation would silently
 * kill provider prompt-cache hits.
 *
 * Run: cd server && node --test core/promptStyle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildWritingStyleAddendum } = require('./promptStyle');

test('addendum carries the three style rules', () => {
    const s = buildWritingStyleAddendum();
    assert.ok(s.includes('space after sentence-ending punctuation'), 'spacing rule');
    assert.ok(s.includes('em-dash'), 'em-dash rule');
    assert.ok(/Dutch/.test(s) && /komma/.test(s), 'hard Dutch rule with native punctuation guidance');
    assert.ok(s.startsWith('\n'), 'safe to append directly after any prompt text');
});

test('byte-stable across calls (prompt-cache friendliness)', () => {
    assert.strictEqual(buildWritingStyleAddendum(), buildWritingStyleAddendum());
    const a = buildWritingStyleAddendum();
    const b = buildWritingStyleAddendum();
    assert.strictEqual(Buffer.from(a).equals(Buffer.from(b)), true);
});

test('short enough to be a negligible token cost', () => {
    assert.ok(buildWritingStyleAddendum().length < 600, 'stays a ~60-token layer');
});

test('the reply-language rule follows the latest message and outranks a remembered language (BFSF-387)', () => {
    const { buildResponseLanguageRule } = require('./promptStyle');
    const s = buildResponseLanguageRule();
    assert.ok(s.startsWith('\n'), 'safe to append directly after any prompt text');
    assert.ok(s.includes("language of the user's latest message"));
    assert.ok(s.includes('Active Memory never overrides'));
    assert.strictEqual(buildResponseLanguageRule(), s, 'byte-stable for prompt caching');
});
