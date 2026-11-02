/**
 * auth/admin/defaultGroupFilter.mts: which stored default groups may be
 * applied to a new member of an organisation.
 * Run: cd server && node --test auth/admin/defaultGroupFilter.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applicableDefaultGroups, isPlainGlobalGroup, isApplicableDefaultGroup } = require('./defaultGroupFilter.mts');

const groups = [
    { id: 'own', organizationId: 'acme' },
    { id: 'foreign', organizationId: 'beta' },
    { id: 'admins', organizationId: null, permissions: ['all'] },
    { id: 'adminPerm', organizationId: null, permissions: ['admin'] },
    { id: 'roled', organizationId: null, roles: ['some-role'] },
    { id: 'orgRoled', organizationId: null, orgRole: 'org_admin' },
    { id: 'users', organizationId: null, permissions: ['read', 'chat'] },
    { id: 'empty', organizationId: '' },
];

test('keeps own-org and plain global groups, in stored order, once', () => {
    const ids = ['users', 'own', 'foreign', 'admins', 'adminPerm', 'roled', 'orgRoled', 'gone', 'own', '', null, 'empty'];
    assert.deepEqual(applicableDefaultGroups(ids, groups, 'acme'), ['users', 'own', 'empty']);
});

test('a group of another organisation is never applied', () => {
    assert.equal(isApplicableDefaultGroup(groups[1], 'acme'), false);
    assert.equal(isApplicableDefaultGroup(groups[0], null), false);
});

test('a global group with an admin permission, a role or an orgRole is not plain', () => {
    for (const g of groups.slice(2, 6)) assert.equal(isPlainGlobalGroup(g), false, g.id);
    assert.equal(isPlainGlobalGroup(groups[6]), true);
    assert.equal(isPlainGlobalGroup(null), false);
});

test('non-list input yields nothing', () => {
    assert.deepEqual(applicableDefaultGroups('admins', groups, 'acme'), []);
    assert.deepEqual(applicableDefaultGroups(['users'], null, 'acme'), []);
});
