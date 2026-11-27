'use strict';
/**
 * boot/optionalRequire.js: a missing module file reads as null, every other
 * failure is thrown on.
 *
 * Run: cd server && node --test boot/optionalRequire.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireIfPresent } = require('./optionalRequire');

test('a file that is there: its exports', () => {
    assert.equal(requireIfPresent(() => require('./optionalRequire')).requireIfPresent, requireIfPresent);
});

test('a file that is not there: null', () => {
    const missing = './no-such-file-for-this-test';
    assert.equal(requireIfPresent(() => require(missing)), null);
});

test('a file that is there and throws while loading: the error goes on', () => {
    assert.throws(() => requireIfPresent(() => { throw new TypeError('broken module'); }), /broken module/);
});
