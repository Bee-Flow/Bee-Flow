/**
 * auth/admin/platformAdminCount.mts: a change never leaves the server without
 * an account that can act as a platform admin.
 * Run: cd server && node --test auth/admin/platformAdminCount.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leavesNoPlatformAdmin, isActivePlatformAdmin, LAST_PLATFORM_ADMIN_REFUSAL } = require('./platformAdminCount.mts');
const { isPlatformOperator, PLATFORM_OPERATOR_ID } = require('../platformOperator');

const OPTS = { isOperator: isPlatformOperator, operatorSignsInFromConfig: true };
const operator = { id: PLATFORM_OPERATOR_ID, role: 'admin', status: 'active' };
const ann = { id: 'ann', role: 'admin', status: 'active' };
const bob = { id: 'bob', role: 'user', status: 'active' };

test('an active row with role admin is a platform admin; a suspended one or another role is not', () => {
    assert.equal(isActivePlatformAdmin(ann), true);
    assert.equal(isActivePlatformAdmin({ id: 'x', role: 'admin' }), true, 'a row without status is active');
    assert.equal(isActivePlatformAdmin({ ...ann, status: 'suspended' }), false);
    assert.equal(isActivePlatformAdmin(bob), false);
    assert.equal(isActivePlatformAdmin(null), false);
});

test('demoting one platform admin while the operator is active leaves one', () => {
    assert.equal(leavesNoPlatformAdmin([operator, ann, bob], { id: 'ann', role: 'user' }, OPTS), false);
});

test('demoting, suspending or deleting the only active platform admin is refused', () => {
    const rows = [{ ...operator, status: 'suspended' }, ann, bob];
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'ann', role: 'user' }, OPTS), true);
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'ann', status: 'suspended' }, OPTS), true);
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'ann', deleted: true }, OPTS), true);
});

test('suspending the operator is refused when no other platform admin is active', () => {
    assert.equal(leavesNoPlatformAdmin([operator, bob], { id: PLATFORM_OPERATOR_ID, status: 'suspended' }, OPTS), true);
    assert.equal(leavesNoPlatformAdmin([operator, ann], { id: PLATFORM_OPERATOR_ID, status: 'suspended' }, OPTS), false);
});

test('the operator without a row counts while it can sign in from the config', () => {
    assert.equal(leavesNoPlatformAdmin([ann, bob], { id: 'ann', role: 'user' }, OPTS), false);
    assert.equal(leavesNoPlatformAdmin([ann, bob], { id: 'ann', role: 'user' }, { ...OPTS, operatorSignsInFromConfig: false }), true);
});

test('a change that keeps the account a platform admin, or touches someone who is not one, passes', () => {
    const rows = [{ ...operator, status: 'suspended' }, ann, bob];
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'ann', role: 'admin', status: 'active' }, OPTS), false);
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'ann' }, OPTS), false);
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'bob', deleted: true }, OPTS), false);
    assert.equal(leavesNoPlatformAdmin(rows, { id: 'nobody', role: 'user' }, OPTS), false);
});

test('the refusal carries a stable code', () => {
    assert.equal(LAST_PLATFORM_ADMIN_REFUSAL.code, 'last_platform_admin');
    assert.match(LAST_PLATFORM_ADMIN_REFUSAL.error, /platform administrator/);
});
