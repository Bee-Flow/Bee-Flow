'use strict';
/**
 * A new contact address of an organisation (orgContactDomain.mts): a domain another organisation
 * uses is refused without naming it, a platform admin's change confirms the domain, an
 * organisation admin's change does not, and an unchanged domain is left alone.
 *
 * Run: cd server && node --test auth/admin/orgContactDomain.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { contactDomainUpdate, DOMAIN_UNAVAILABLE } = require('./orgContactDomain.mts');

const ORG_ADMIN = { session: { user: { role: 'user' } } };
const PLATFORM = { session: { isAdmin: true, user: { role: 'admin' } } };

/** @param {{ taken?: string[], free?: string[] }} o */
function deps({ taken = [], free = [] } = {}) {
    const asked = [];
    return {
        asked,
        assertDomainAvailable: async (/** @type {string} */ email, /** @type {string} */ except) => {
            asked.push([email, except]);
            if (taken.includes(email.split('@')[1].toLowerCase())) throw Object.assign(new Error('taken'), { code: 'ORG_DOMAIN_TAKEN' });
        },
        isFreeDomain: async (/** @type {string} */ d) => free.includes(d),
    };
}

test('a domain another organisation uses is refused with a message that names nobody', async () => {
    const d = deps({ taken: ['corp.test'] });
    const out = await contactDomainUpdate(ORG_ADMIN, 'mine', { email: 'info@mine.test' }, 'x@corp.test', d);
    assert.deepEqual(out, { refusal: { error: DOMAIN_UNAVAILABLE, code: 'org_domain_unavailable' } });
    assert.deepEqual(d.asked, [['x@corp.test', 'mine']]);
    assert.ok(!DOMAIN_UNAVAILABLE.includes('corp.test'));
});

test('an organisation admin may set a free domain, but it confirms nothing', async () => {
    assert.deepEqual(await contactDomainUpdate(ORG_ADMIN, 'mine', { email: 'info@mine.test' }, 'me@corp.test', deps()), {});
});

test('a platform admin confirms a company domain, never a free-mail one', async () => {
    assert.deepEqual(await contactDomainUpdate(PLATFORM, 'mine', { email: 'info@mine.test' }, 'Info@Corp.Test', deps()), { contactDomainVerified: 'corp.test' });
    assert.deepEqual(await contactDomainUpdate(PLATFORM, 'mine', { email: 'info@mine.test' }, 'me@mail.test', deps({ free: ['mail.test'] })), {});
});

test('the same domain, an empty address or no address in the body changes nothing and checks nothing', async () => {
    const d = deps({ taken: ['mine.test'] });
    assert.deepEqual(await contactDomainUpdate(ORG_ADMIN, 'mine', { email: 'info@mine.test' }, 'sales@MINE.test', d), {});
    assert.deepEqual(await contactDomainUpdate(ORG_ADMIN, 'mine', { email: 'info@mine.test' }, '', d), {});
    assert.deepEqual(await contactDomainUpdate(ORG_ADMIN, 'mine', { email: 'info@mine.test' }, undefined, d), {});
    assert.deepEqual(d.asked, []);
});

test('any other failure of the check is not swallowed', async () => {
    const d = { assertDomainAvailable: async () => { throw new Error('db down'); }, isFreeDomain: async () => false };
    await assert.rejects(() => contactDomainUpdate(ORG_ADMIN, 'mine', null, 'x@corp.test', d), /db down/);
});
