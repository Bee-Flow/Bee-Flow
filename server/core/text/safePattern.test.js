'use strict';
/**
 * hasNestedQuantifier: the catastrophic-backtracking shape is refused, safe
 * patterns pass, and the App Studio path still reaches the same function.
 *
 * Run: node --test core/text/safePattern.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { hasNestedQuantifier } = require('./safePattern');

test('a quantified group that contains a quantifier is refused', () => {
    for (const p of ['(a+)+', '(\\w*)+$', '(a?)+', '((ab)+)*', '(x{1,3})+', '(?:[a-z]+\\d)+']) {
        assert.equal(hasNestedQuantifier(p), true, p);
    }
});

test('flat and bounded patterns pass', () => {
    for (const p of ['KL-\\d{5}', '\\bKL-[0-9]{5}\\b', '(ab)+', '[A-Z]{2}\\d+', '(?:foo|bar)', 'a+b*c?', '[(+)]+', '\\(a+\\)+']) {
        assert.equal(hasNestedQuantifier(p), false, p);
    }
});

test('the old App Studio path re-exports the same function', () => {
    assert.equal(require('../../appStudio/safePattern').hasNestedQuantifier, hasNestedQuantifier);
});
