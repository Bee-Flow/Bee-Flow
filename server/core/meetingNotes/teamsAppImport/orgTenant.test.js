'use strict';
/**
 * The verified tenant of an organisation: the directory sync binding, its
 * conflict with a different configured sign-in tenant, the single-organisation
 * rule, and "not bound" for everything else (two organisations without a
 * binding, a binding for another organisation, common). Plus the memo.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAppImport/orgTenant.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const orgTenant = require('./orgTenant.mts');

const T = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

function setup({ binding = null, tenantId = 'common', orgs = [{ id: 'org-a' }, { id: 'org-b' }] } = {}) {
    const calls = { binding: 0 };
    const fx = { binding, tenantId, orgs };
    orgTenant.init({
        getSyncBinding: async () => { calls.binding++; if (fx.bindingError) throw fx.bindingError; return fx.binding; },
        loadConfig: async () => ({ providers: { microsoft: { clientId: 'x', clientSecret: 'fixture-not-a-secret', tenantId: fx.tenantId } } }),
        getAllOrganizations: async () => fx.orgs,
    });
    return { calls, fx };
}

test.afterEach(() => orgTenant.init());

test('the directory binding of this organisation gives its tenant (lower-cased)', async () => {
    setup({ binding: { syncOrganizationId: 'org-a', syncTenantId: T.toUpperCase() } });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: true, tenantId: T, source: 'directory_binding' });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-b'), { ok: false, reason: 'tenant_not_bound' }, 'the binding names one organisation only');
});

test('a binding that differs from a configured GUID sign-in tenant is a mismatch; the same GUID is fine', async () => {
    setup({ binding: { syncOrganizationId: 'org-a', syncTenantId: T }, tenantId: OTHER });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: false, reason: 'tenant_mismatch_sso' });
    setup({ binding: { syncOrganizationId: 'org-a', syncTenantId: T }, tenantId: T });
    assert.equal((await orgTenant.orgVerifiedTenant('org-a')).ok, true);
});

test('single organisation with a GUID sign-in tenant; two organisations are not bound', async () => {
    setup({ tenantId: T, orgs: [{ id: 'org-a' }] });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: true, tenantId: T, source: 'single_org' });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-z'), { ok: false, reason: 'tenant_not_bound' });
    setup({ tenantId: T, orgs: [{ id: 'org-a' }, { id: 'org-b' }] });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: false, reason: 'tenant_not_bound' });
});

test('common or organizations as sign-in tenant never binds; neither does a binding with a non-GUID tenant', async () => {
    for (const tenantId of ['common', 'organizations', 'consumers', '']) {
        setup({ tenantId, orgs: [{ id: 'org-a' }] });
        assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: false, reason: 'tenant_not_bound' }, tenantId);
    }
    setup({ binding: { syncOrganizationId: 'org-a', syncTenantId: 'common' } });
    assert.deepEqual(await orgTenant.orgVerifiedTenant('org-a'), { ok: false, reason: 'tenant_not_bound' });
    assert.deepEqual(await orgTenant.orgVerifiedTenant(null), { ok: false, reason: 'tenant_not_bound' });
});

test('memoised for 60 s; fresh skips the memo; a failed read throws and is not memoised', async () => {
    const { calls, fx } = setup({ binding: { syncOrganizationId: 'org-a', syncTenantId: T } });
    const now = 1_000_000;
    await orgTenant.orgVerifiedTenant('org-a', { now });
    fx.binding = { syncOrganizationId: 'org-b', syncTenantId: T };
    assert.equal((await orgTenant.orgVerifiedTenant('org-a', { now: now + 59_000 })).ok, true, 'memo');
    assert.equal(calls.binding, 1);
    assert.equal((await orgTenant.orgVerifiedTenant('org-a', { now: now + 59_000, fresh: true })).ok, false, 'fresh sees the move');
    assert.equal((await orgTenant.orgVerifiedTenant('org-b', { now: now + 61_000 })).ok, true);
    fx.bindingError = new Error('db down');
    await assert.rejects(orgTenant.orgVerifiedTenant('org-c', { now }), /db down/);
    fx.bindingError = null;
    fx.binding = { syncOrganizationId: 'org-c', syncTenantId: T };
    assert.equal((await orgTenant.orgVerifiedTenant('org-c', { now })).ok, true);
});
