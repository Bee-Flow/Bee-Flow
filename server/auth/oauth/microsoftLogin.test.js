// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedMicrosoftOrg, autoLinkOnLogin, saveMicrosoftPhoto } = require('./microsoftLogin');

const T = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const store = (/** @type {unknown[]} */ orgs) => ({ getAllOrganizations: async () => orgs });
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

test('an account from before tenant binding is linked on its first login, and the caller hears whether it was', async () => {
    /** @type {unknown[]} */
    const asked = [];
    const linking = (/** @type {boolean} */ linked) => /** @type {any} */ ({ autoLinkLegacy: async (/** @type {unknown} */ who) => { asked.push(who); return { linked, userId: 'u-1', basis: 'email' }; } });
    const user = { azureUserId: 'oid-1', azureTenantId: T, email: 'a@example.test' };
    assert.equal(await autoLinkOnLogin(user, T, linking(true)), true);
    assert.equal(await autoLinkOnLogin(user, T, linking(false)), false);
    assert.deepEqual(asked[0], { azureTenantId: T, azureUserId: 'oid-1', email: 'a@example.test', configuredTenantId: T });

    // Without both halves of the Microsoft identity there is nothing to link, and the store is not asked.
    asked.length = 0;
    assert.equal(await autoLinkOnLogin({ azureUserId: 'oid-1', azureTenantId: null }, T, linking(true)), false);
    assert.equal(await autoLinkOnLogin({ azureUserId: null, azureTenantId: T }, T, linking(true)), false);
    assert.deepEqual(asked, []);
});

test('a profile photo is stored under uploads, in a folder that may already be there; no photo is no upload', async (t) => {
    const fs = require('node:fs');
    const made = t.mock.method(fs, 'mkdirSync', () => undefined);
    const written = t.mock.method(fs, 'writeFileSync', () => undefined);
    const photo = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const url = await saveMicrosoftPhoto('graph-token', /** @type {any} */ ({ azureUserId: 'oid-1/..', email: 'a@example.test' }));
    assert.match(String(url), /^\/uploads\/user-avatar-azure-oid1-\d+\.jpg$/, 'the id is reduced to letters and digits');
    assert.equal(made.mock.callCount(), 1);
    assert.deepEqual(made.mock.calls[0].arguments[1], { recursive: true });
    assert.deepEqual([.../** @type {Uint8Array} */ (written.mock.calls[0].arguments[1])], [1, 2, 3]);
    assert.equal(/** @type {any} */ (photo.mock.calls[0].arguments[1]).headers.Authorization, 'Bearer graph-token');

    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    assert.equal(await saveMicrosoftPhoto('graph-token', /** @type {any} */ ({ azureUserId: 'oid-1' })), null);
    assert.equal(written.mock.callCount(), 1, 'nothing more was written');
});
