/**
 * checkRegexPatterns (core/privacy/guardrails.js) runs admin-written rules on
 * text users control: a rule compiles under RE2 so the classic catastrophic
 * shape answers in linear time, a rule the engine refuses is skipped and
 * reported, and the (?i) prefix some admins write still works.
 *
 * Run: cd server && node --test core/privacy/guardrails.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { checkRegexPatterns } = require('./guardrails');

test('rules match case-insensitively, with or without an inline (?i) prefix', () => {
    const rules = [{ name: 'iban', pattern: '(?i)NL\\d{2}[A-Z]{4}\\d{10}' }, { name: 'word', pattern: 'secret' }];
    assert.deepStrictEqual(
        checkRegexPatterns('pay to nl91abna0417164300 SECRET', rules).map(m => m.ruleName),
        ['iban', 'word'],
    );
    assert.deepStrictEqual(checkRegexPatterns('nothing here', rules), []);
    assert.deepStrictEqual(checkRegexPatterns({ a: 'secret' }, rules).map(m => m.ruleName), ['word']);
});

test('the catastrophic shape answers in bounded time on a long crafted text', () => {
    const t0 = Date.now();
    const out = checkRegexPatterns('a'.repeat(100_000) + '!', [{ name: 'nested', pattern: '^(a+)+$' }, { name: 'bang', pattern: '!$' }]);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.deepStrictEqual(out.map(m => m.ruleName), ['bang']);
});

test('a rule the engine refuses is skipped, the other rules still run', () => {
    const out = checkRegexPatterns('aaab 123', [
        { name: 'refused', pattern: '(a+)+(?=b)' },
        { name: 'broken', pattern: '[' },
        { name: 'digits', pattern: '\\d+' },
    ]);
    assert.deepStrictEqual(out.map(m => m.ruleName), ['digits']);
});
