/**
 * Unit — _evalOrgAdmin pure org-admin predicate (H4). DB-free: stubs the
 * userStore/db module deps so permissions.js loads without the DB chain, then
 * exercises the pure evaluator with plain user + group data.
 * Run: node --test auth/orgAdmin.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');
// Neutralise permissions.js's module-load DB dependencies.
const restore = installResolveStub({
    '../stores/userStore': {},
    '../db': { getRedis: () => null },
});
const { _evalOrgAdmin } = require('./permissions');
restore();

const ORG = 'org1';
const groups = [
    { id: 'g-admin', organizationId: 'org1', permissions: ['all'], roles: [] },
    { id: 'g-role', organizationId: 'org1', permissions: [], roles: ['org_admin'] },
    { id: 'g-plain', organizationId: 'org1', permissions: ['read'], roles: ['member'] },
    { id: 'g-otherorg', organizationId: 'org2', permissions: ['all'], roles: [] },
];

test('direct: own org + org_admin orgRole → true', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: ORG, orgRole: 'org_admin', groups: [] }, groups, ORG), true);
});

test('direct: legacy "admin" orgRole passes by default, fails under strictOrgRole', () => {
    const u = { organizationId: ORG, orgRole: 'admin', groups: [] };
    assert.strictEqual(_evalOrgAdmin(u, groups, ORG), true, 'default accepts legacy admin');
    assert.strictEqual(_evalOrgAdmin(u, groups, ORG, { strictOrgRole: true }), false, 'strict rejects legacy admin');
});

test('direct: admin orgRole but a DIFFERENT org → false', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'org2', orgRole: 'org_admin', groups: [] }, groups, ORG), false);
});

test('group: member of an admin-perm group in the org → true', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: ['g-admin'] }, groups, ORG), true);
});

test('group: member of an org_admin-role group in the org → true', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: ['g-role'] }, groups, ORG), true);
});

test('group: plain (non-admin) group in the org → false', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: ['g-plain'] }, groups, ORG), false);
});

test('group: admin group but in a DIFFERENT org → false', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: ['g-otherorg'] }, groups, ORG), false);
});

test('groups can be a JSON string (as stored) — parsed, not crashed', () => {
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: '["g-admin"]' }, groups, ORG), true);
});

test('null user → false; unparseable groups → false, never throws', () => {
    assert.strictEqual(_evalOrgAdmin(null, groups, ORG), false);
    assert.strictEqual(_evalOrgAdmin({ organizationId: 'orgX', orgRole: 'member', groups: 'not json' }, groups, ORG), false);
});
