'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedMicrosoftOrg } = require('./microsoftLogin');

const T = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const store = (orgs) => ({ getAllOrganizations: async () => orgs });
const noBinding = async () => null;

test('a new Microsoft user lands in the org the Azure sync binding names for its tenant', async () => {
    const orgs = [{ id: 'a' }, { id: 'b' }];
    const org = await trustedMicrosoftOrg({ azureTenantId: T }, 'common', store(orgs), async () => ({ syncOrganizationId: 'b', syncTenantId: T.toUpperCase() }));
    assert.equal(org.id, 'b');
});

test('without a binding: the only org, when the token comes from the configured concrete tenant', async () => {
    assert.equal((await trustedMicrosoftOrg({ azureTenantId: T }, T, store([{ id: 'only' }]), noBinding)).id, 'only');
});

test('never by guesswork: other tenant, common, several orgs, no tenant', async () => {
    assert.equal(await trustedMicrosoftOrg({ azureTenantId: OTHER }, T, store([{ id: 'only' }]), noBinding), null);
    assert.equal(await trustedMicrosoftOrg({ azureTenantId: T }, 'common', store([{ id: 'only' }]), noBinding), null);
    assert.equal(await trustedMicrosoftOrg({ azureTenantId: T }, T, store([{ id: 'a' }, { id: 'b' }]), noBinding), null);
    assert.equal(await trustedMicrosoftOrg({ azureTenantId: null }, T, store([{ id: 'only' }]), noBinding), null);
    const otherBinding = async () => ({ syncOrganizationId: 'a', syncTenantId: OTHER });
    assert.equal(await trustedMicrosoftOrg({ azureTenantId: T }, T, store([{ id: 'a' }, { id: 'b' }]), otherBinding), null);
});

test('an unreadable binding falls back to the single-org rule instead of failing the login', async () => {
    const broken = async () => { throw new Error('db down'); };
    assert.equal((await trustedMicrosoftOrg({ azureTenantId: T }, T, store([{ id: 'only' }]), broken)).id, 'only');
});
