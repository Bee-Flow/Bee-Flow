// @typecheck
/**
 * The expression engine's size limits (limits.mjs): a pad width is clamped,
 * a text no function may grow past the cap is refused before it is built, and
 * the cap is configurable (0 = unlimited).
 *
 * Run: cd server && node --test shared/expr/limits.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { evaluate, ExprError } from './index.mjs';
import { padStartCp } from './codePoints.mjs';
import { DEFAULT_MAX_TEXT_CHARS, MAX_PAD_WIDTH, getMaxTextChars, setMaxTextChars, ExprLimitError } from './limits.mjs';

test.afterEach(() => setMaxTextChars(DEFAULT_MAX_TEXT_CHARS));

test('padStart with an enormous width returns at once, padded to the clamp', () => {
    const t0 = Date.now();
    const out = padStartCp('', 1e9, '*');
    assert.ok(Date.now() - t0 < 1000, 'answered within a second');
    assert.strictEqual(out.length, MAX_PAD_WIDTH);
    assert.strictEqual(evaluate('padStart("7", 1000000000000, "0")', {}).length, MAX_PAD_WIDTH);
    // An ordinary width is untouched.
    assert.strictEqual(evaluate('padStart("7", 3, "0")', {}), '007');
});

test('replace that would multiply its input is refused before it is built', () => {
    setMaxTextChars(10_000);
    const seed = 'a'.repeat(100);
    assert.throws(
        () => evaluate('replace(replace(s, "a", s), "a", s)', { s: seed }),
        (err) => err instanceof ExprLimitError && err instanceof ExprError && err.code === 'expr_limit',
    );
    // Under the cap the same shape works.
    assert.strictEqual(evaluate('replace(s, "a", "bb")', { s: seed }).length, 200);
});

test('concat, join and + obey the same cap', () => {
    setMaxTextChars(50);
    const s = 'x'.repeat(30);
    assert.throws(() => evaluate('concat(s, s)', { s }), ExprLimitError);
    assert.throws(() => evaluate('join(list, "-")', { s, list: [s, s] }), ExprLimitError);
    assert.throws(() => evaluate('s + s', { s }), ExprLimitError);
    assert.strictEqual(evaluate('s + "y"', { s }).length, 31);
    // Numbers are not texts: arithmetic never trips the cap.
    assert.strictEqual(evaluate('1 + 2', {}), 3);
});

test('a value a function hands back past the cap is refused, whichever function', () => {
    setMaxTextChars(5);
    assert.throws(() => evaluate('upper("abcdef")', {}), ExprLimitError);
    assert.strictEqual(evaluate('upper("abc")', {}), 'ABC');
});

test('0 means unlimited', () => {
    setMaxTextChars(0);
    assert.strictEqual(getMaxTextChars(), Infinity);
    const s = 'x'.repeat(2_000_000);
    assert.strictEqual(evaluate('s + s', { s }).length, 4_000_000);
});
