'use strict';
/**
 * Pattern tools: the safety rules (and that the engine gets the last word),
 * complete matches, deterministic inference and the words for a pattern.
 *
 * Run: node --test core/privacy/customData/patternTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    localPatternCheck, validatePattern, fullMatchAll, inferPatternFromExamples, describePattern,
} = require('./patternTools');

test('the local rules refuse unsafe or useless patterns', () => {
    assert.deepEqual(localPatternCheck('KL-\\d{5}', false), { ok: true });
    assert.equal(localPatternCheck('(a+)+', false).reason, 'nested_quantifier');
    assert.equal(localPatternCheck('(\\w*)+$', false).reason, 'nested_quantifier');
    assert.equal(localPatternCheck('\\d*', false).reason, 'matches_empty');
    assert.equal(localPatternCheck('\\b', false).reason, 'matches_empty');
    assert.equal(localPatternCheck('a|', false).reason, 'matches_empty');
    assert.equal(localPatternCheck('(', false).reason, 'does_not_compile');
    assert.equal(localPatternCheck('', false).reason, 'empty');
    assert.equal(localPatternCheck('a'.repeat(301), false).reason, 'too_long');
});

test('validatePattern asks the engine after the local rules, and the engine decides', async () => {
    const calls = [];
    const engine = {
        validateTypeSpec: (spec) => {
            calls.push(spec);
            return spec.pattern.source.includes('(?=')
                ? { ok: false, errors: [{ id: spec.id, field: 'pattern.source', code: 're2_unsupported', message: 'x' }] }
                : { ok: true, normalized: spec };
        },
    };
    assert.deepEqual(await validatePattern('KL-\\d{5}', true, { engine }), { ok: true });
    assert.equal(calls[0].method, 'pattern');
    assert.equal(calls[0].pattern.caseSensitive, true);
    assert.deepEqual(await validatePattern('KL(?=-)', false, { engine }), { ok: false, reason: 're2_unsupported' });
    // A local refusal never reaches the engine.
    const before = calls.length;
    assert.equal((await validatePattern('(a+)+', false, { engine })).reason, 'nested_quantifier');
    assert.equal(calls.length, before);
    // An engine that throws is a refusal, not a pass.
    assert.equal((await validatePattern('abc', false, { engine: { validateTypeSpec: () => { throw new Error('x'); } } })).reason, 'check_failed');
    // Errors about the probe's own identity fields are not about the pattern.
    const picky = { validateTypeSpec: async () => ({ ok: false, errors: [{ field: 'tokenKey', code: 'reserved' }] }) };
    assert.deepEqual(await validatePattern('abc', false, { engine: picky }), { ok: true });
});

test('fullMatchAll anchors the whole value', () => {
    assert.equal(fullMatchAll('KL-\\d{5}', ['KL-12345', 'KL-99812']), true);
    assert.equal(fullMatchAll('KL-\\d{5}', ['KL-123456']), false);
    assert.equal(fullMatchAll('KL-\\d{5}', ['xKL-12345']), false);
    assert.equal(fullMatchAll('a|b', ['ab']), false, 'alternation is grouped before anchoring');
    assert.equal(fullMatchAll('kl-\\d{5}', ['KL-12345']), false);
    assert.equal(fullMatchAll('kl-\\d{5}', ['KL-12345'], { caseSensitive: false }), true);
    assert.equal(fullMatchAll('(', ['x']), false);
    assert.equal(fullMatchAll('x', []), true);
});

test('inference: fixed prefix and a fixed number of digits', () => {
    const out = inferPatternFromExamples(['KL-12345', 'KL-99812'], true);
    assert.equal(out[0], 'KL-\\d{5}');
    assert.ok(out.includes('\\bKL-\\d{5}\\b'));
    for (const p of out) assert.equal(fullMatchAll(p, ['KL-12345', 'KL-99812']), true, p);
});

test('inference: mixed lengths widen to a range', () => {
    const out = inferPatternFromExamples(['KL-123', 'KL-45678', 'KL-9012'], true);
    assert.equal(out[0], 'KL-\\d{3,5}');
    assert.equal(describePattern(out[0]), 'KL- followed by 3 to 5 digits');
});

test('inference: letter and digit runs, a suffix, and a loose variant', () => {
    const out = inferPatternFromExamples(['AB12-NL', 'CD34-NL'], true);
    assert.equal(out[0], '[A-Z]{2}\\d{2}-NL');
    assert.ok(out.includes('[A-Za-z0-9]{4}-NL'));
    const mixed = inferPatternFromExamples(['A1B2', 'AB12'], true);
    assert.ok(mixed.length > 0);
    for (const p of mixed) assert.equal(fullMatchAll(p, ['A1B2', 'AB12']), true, p);
});

test('inference: case-insensitive folds the literal prefix', () => {
    const out = inferPatternFromExamples(['KL-12345', 'kl-99812'], false);
    assert.equal(out[0], 'KL-\\d{5}');
    assert.equal(fullMatchAll(out[0], ['kl-99812'], { caseSensitive: false }), true);
});

test('inference: different separators fall back to one class', () => {
    const out = inferPatternFromExamples(['12-34', '12/345'], true);
    assert.ok(out.length > 0);
    for (const p of out) assert.equal(fullMatchAll(p, ['12-34', '12/345']), true, p);
});

test('inference: nothing to infer', () => {
    assert.deepEqual(inferPatternFromExamples([], true), []);
    assert.deepEqual(inferPatternFromExamples(['Zürich-1'], true), []);
});

test('every inferred pattern passes the local safety rules', () => {
    for (const ex of [['KL-12345', 'KL-99812'], ['A', 'AB'], ['12', '123'], ['x-1', 'y-22-z']]) {
        for (const p of inferPatternFromExamples(ex, true)) {
            const r = localPatternCheck(p, true);
            if (!r.ok) assert.equal(r.reason, 'matches_empty', `${p}: ${r.reason}`);
        }
    }
});

test('describePattern reads only its own grammar', () => {
    assert.equal(describePattern('KL-\\d{5}'), 'KL- followed by 5 digits');
    assert.equal(describePattern('\\bKL-\\d{5}\\b'), 'KL- followed by 5 digits');
    assert.equal(describePattern('[A-Z]{2}\\d-NL'), '2 capital letters followed by 1 digit followed by -NL');
    assert.equal(describePattern('[A-Za-z0-9]{4,6}'), '4 to 6 letters or digits');
    assert.equal(describePattern('a.b'), null);
    assert.equal(describePattern('\\d+'), null);
    assert.equal(describePattern('(KL)-\\d'), null);
    assert.equal(describePattern(''), null);
});
