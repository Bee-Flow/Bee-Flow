// @typecheck strict
'use strict';
/**
 * hasNestedQuantifier: the catastrophic-backtracking shape is refused and safe
 * patterns pass. App Studio's use of it (file_intake's poPattern) is pinned in
 * appStudio/validate/actions.validateStep.test.js.
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
