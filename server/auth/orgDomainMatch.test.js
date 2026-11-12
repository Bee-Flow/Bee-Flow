'use strict';
/**
 * Placing a new single-sign-on account by its e-mail domain (orgDomainMatch.mts): a contact
 * address counts only when its domain is confirmed for that organisation, the address must be
 * one the provider verified, and a domain two organisations match places nobody.
 *
 * Run: cd server && node --test auth/orgDomainMatch.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { orgForNewAccount, confirmedContactOrgIds, domainOf } = require('./orgDomainMatch.mts');

/** @param {{ orgs: any[], admins?: Record<string, string[]>, free?: string[] }} o */
const deps = ({ orgs, admins = {}, free = [] }) => ({
    getAllOrganizations: async () => orgs,
    freeDomains: async () => new Set(free),
    orgIdsWithVerifiedAdminAtDomain: async (/** @type {string} */ d) => admins[d] || [],
});

const COMPANY = { id: 'company', email: 'info@corp.test', allowedDomains: [] };
const OTHER = { id: 'other', email: 'billing@corp.test', allowedDomains: [] };

test('an organisation whose contact address is on the domain, with nothing confirming it, places nobody', async () => {
    assert.equal(await orgForNewAccount('new@corp.test', true, deps({ orgs: [OTHER] })), null);
});

test('the domain counts once an administrator of the organisation has a verified address on it', async () => {
    const d = deps({ orgs: [COMPANY], admins: { 'corp.test': ['company'] } });
    assert.equal((await orgForNewAccount('new@corp.test', true, d))?.id, 'company');
});

test('a platform admin who set the contact address confirms its domain', async () => {
    const d = deps({ orgs: [{ ...COMPANY, contact_domain_verified: 'corp.test' }] });
    assert.equal((await orgForNewAccount('new@Corp.Test', true, d))?.id, 'company');
    // The confirmation is for that domain: a contact address moved elsewhere is not confirmed by it.
    const moved = deps({ orgs: [{ ...COMPANY, email: 'info@else.test', contact_domain_verified: 'corp.test' }] });
    assert.equal(await orgForNewAccount('new@else.test', true, moved), null);
});

test('a confirmed organisation and an unconfirmed one on the same domain: the confirmed one', async () => {
    const d = deps({ orgs: [OTHER, COMPANY], admins: { 'corp.test': ['company'] } });
    assert.equal((await orgForNewAccount('new@corp.test', true, d))?.id, 'company');
});

test('two organisations confirmed on the same domain place nobody', async () => {
    const d = deps({ orgs: [COMPANY, OTHER], admins: { 'corp.test': ['company', 'other'] } });
    assert.equal(await orgForNewAccount('new@corp.test', true, d), null);
});

test('an address the provider did not verify never matches a contact address', async () => {
    const d = deps({ orgs: [COMPANY], admins: { 'corp.test': ['company'] } });
    assert.equal(await orgForNewAccount('new@corp.test', false, d), null);
});

test('an operator-listed domain (allowedDomains) matches as before', async () => {
    const d = deps({ orgs: [{ id: 'listed', allowedDomains: ['corp.test'] }] });
    assert.equal((await orgForNewAccount('new@corp.test', false, d))?.id, 'listed');
});

test('a free-mail domain never places anyone', async () => {
    const d = deps({ orgs: [{ id: 'f', email: 'x@mail.test', allowedDomains: [], contact_domain_verified: 'mail.test' }], admins: { 'mail.test': ['f'] }, free: ['mail.test'] });
    assert.equal(await orgForNewAccount('new@mail.test', true, d), null);
});

test('confirmedContactOrgIds and domainOf', async () => {
    assert.equal(domainOf(' A@B.Test '), 'b.test');
    assert.equal(domainOf('nope'), '');
    assert.equal(domainOf('x@'), '');
    const ids = await confirmedContactOrgIds('corp.test', [COMPANY, { ...OTHER, contact_domain_verified: 'corp.test' }], deps({ orgs: [] }));
    assert.deepEqual([...ids], ['other']);
});
