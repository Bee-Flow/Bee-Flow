// @typecheck strict
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isPlatformOperator } = require('./platformOperator');

test('the built-in operator account, by user or by id, and nobody else', () => {
    assert.strictEqual(isPlatformOperator({ id: 'admin' }), true);
    assert.strictEqual(isPlatformOperator('admin'), true);
    // A super admin by role is not the operator account.
    assert.strictEqual(isPlatformOperator(/** @type {any} */ ({ id: 'u1', role: 'admin' })), false);
    for (const v of ['Admin', 'u1', '', null, undefined, { id: null }, {}]) assert.strictEqual(isPlatformOperator(/** @type {any} */ (v)), false);
});
