// @typecheck
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _isEligibleStaff } = require('./supportAutoAssigner');

const permsOf = (/** @type {string[]} */ perms) => async () => perms;

test('a platform admin is eligible for any thread, with or without an org', async () => {
    const u = { id: 'p', role: 'admin' };
    assert.strictEqual(await _isEligibleStaff(u, 'o1', permsOf(['all'])), true);
    assert.strictEqual(await _isEligibleStaff(u, /** @type {any} */ (null), permsOf(['all'])), true);
});

test('org staff with admin_support are eligible for their own org only', async () => {
    const u = { id: 's', role: 'user', organizationId: 'o1' };
    assert.strictEqual(await _isEligibleStaff(u, 'o1', permsOf(['admin_support'])), true);
    assert.strictEqual(await _isEligibleStaff(u, 'o2', permsOf(['admin_support'])), false);
    assert.strictEqual(await _isEligibleStaff(u, /** @type {any} */ (null), permsOf(['admin_support'])), false);
});

test('a user who only holds the all wildcard is not eligible', async () => {
    assert.strictEqual(await _isEligibleStaff({ id: 'w', role: 'user', organizationId: 'o1' }, 'o1', permsOf(['all'])), false);
});

test('disabled accounts and failed permission lookups are not eligible', async () => {
    assert.strictEqual(await _isEligibleStaff({ id: 'd', role: 'admin', disabled: true }, 'o1', permsOf([])), false);
    const failing = async () => { throw new Error('store down'); };
    assert.strictEqual(await _isEligibleStaff({ id: 'f', role: 'user', organizationId: 'o1' }, 'o1', failing), false);
});

test('tenant inbox eligibility follows the inbox gate: support_inbox or all, own org only', async () => {
    const u = { id: 't', role: 'user', organizationId: 'o1' };
    assert.strictEqual(await _isEligibleStaff(u, 'o1', permsOf(['all']), true), true);
    assert.strictEqual(await _isEligibleStaff(u, 'o1', permsOf(['support_inbox']), true), true);
    assert.strictEqual(await _isEligibleStaff(u, 'o1', permsOf(['chat']), true), false);
    assert.strictEqual(await _isEligibleStaff(u, 'o2', permsOf(['all']), true), false);
});
