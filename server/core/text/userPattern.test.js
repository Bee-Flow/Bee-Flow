/**
 * Patterns from authors and admins (core/text/userPattern.js): compiled under
 * RE2 whenever possible, so a pattern that would take V8 exponential time
 * answers in linear time; a pattern RE2 cannot run falls back to the native
 * engine only without nested quantifiers and only off the event loop, under
 * a budget; a refused pattern says why.
 *
 * Run: cd server && node --test core/text/userPattern.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { compileUserPattern, testUserPattern, replaceUserPattern, findUserPatternMatches, _resetUserPatternCache } = require('./userPattern');
const { _resetLegacyRunner } = require('../privacy/customTypes/legacyRunner');

test.after(() => _resetLegacyRunner());
test.beforeEach(() => _resetUserPatternCache());

test('an ordinary pattern runs under RE2, case-insensitively, with the inline flag prefix tolerated', () => {
    for (const p of ['\\d{3}-\\d{2}', '(?i)\\d{3}-\\d{2}']) {
        const c = compileUserPattern(p);
        assert.strictEqual(c.ok && c.engine, 're2', p);
        assert.strictEqual(testUserPattern(c, 'ref 123-45'), true);
        assert.strictEqual(testUserPattern(c, 'none'), false);
        assert.strictEqual(replaceUserPattern(c, 'a 123-45 b 678-90', '[X]'), 'a [X] b [X]');
    }
    const cs = compileUserPattern('iban', { caseInsensitive: false });
    assert.strictEqual(testUserPattern(cs, 'IBAN'), false);
    assert.strictEqual(testUserPattern(compileUserPattern('iban'), 'IBAN'), true);
});

test('the classic catastrophic shape answers in bounded time on a long input', () => {
    const c = compileUserPattern('^(a+)+$');
    assert.strictEqual(c.ok && c.engine, 're2');
    const t0 = Date.now();
    assert.strictEqual(testUserPattern(c, 'a'.repeat(100_000) + '!'), false);
    assert.strictEqual(replaceUserPattern(c, 'a'.repeat(100_000) + '!', ''), 'a'.repeat(100_000) + '!');
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('a pattern RE2 cannot run is refused when it nests quantifiers', () => {
    const c = compileUserPattern('(a+)+(?=b)');
    assert.deepStrictEqual([c.ok, c.reason], [false, 'nested_quantifier']);
    assert.strictEqual(testUserPattern(c, 'aaab'), null);
    assert.strictEqual(replaceUserPattern(c, 'aaab', 'x'), null);
    assert.strictEqual(compileUserPattern('').ok, false);
    assert.strictEqual(compileUserPattern('[unclosed').reason, 'does_not_compile');
});

test('a lookaround pattern without nesting runs on the native engine, off the event loop', () => {
    const c = compileUserPattern('\\d+(?= euro)');
    assert.strictEqual(c.ok && c.engine, 'native');
    assert.strictEqual(testUserPattern(c, 'pay 40 euro'), true);
    assert.strictEqual(testUserPattern(c, 'pay 40 dollar'), false);
    assert.strictEqual(replaceUserPattern(c, 'pay 40 euro and 5 euro', '[N]'), 'pay [N] euro and [N] euro');
    assert.deepStrictEqual(findUserPatternMatches(c, 'pay 40 euro and 5 euro'), [{ match: '40', index: 4 }, { match: '5', index: 16 }]);
});

test('the native fallback within a budget: a slow pattern is undecided, not a stall', () => {
    const saved = process.env.USER_PATTERN_BUDGET_MS;
    process.env.USER_PATTERN_BUDGET_MS = '30';
    try {
        // Polynomial, not exponential (no nesting), yet slow enough on this input to overrun 30 ms.
        const c = compileUserPattern('(?=.*x)a*a*a*a*a*b');
        assert.strictEqual(c.ok && c.engine, 'native');
        const t0 = Date.now();
        const verdict = testUserPattern(c, 'a'.repeat(20_000));
        assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
        assert.ok(verdict === null || verdict === false);
    } finally {
        if (saved === undefined) delete process.env.USER_PATTERN_BUDGET_MS; else process.env.USER_PATTERN_BUDGET_MS = saved;
    }
});

test('matches are listed with their positions, capped', () => {
    const c = compileUserPattern('[a-z]+');
    assert.deepStrictEqual(findUserPatternMatches(c, 'ab 12 cd', 5), [{ match: 'ab', index: 0 }, { match: 'cd', index: 6 }]);
    assert.strictEqual(findUserPatternMatches(c, 'a b c d', 2).length, 2);
});
