// @typecheck
/**
 * `homeOrganization` on GET /auth/my-permissions: the caller's home
 * organisation (users.organizationId) with its name, so the admin dashboard
 * can say which organisation an organisation admin manages.
 *
 *   - a home organisation is `{ id, name }`;
 *   - no home organisation is null;
 *   - an organisation that cannot be read keeps its id with a null name, and
 *     the rest of the answer is still served.
 *
 * No module mocking: the store and the permission snapshot are swapped on their
 * module objects (testUtils/swaps) before the router is required.
 *
 * Run: cd server && node --test auth/login/myPermissionsRoutes.homeOrganization.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { myPermissionsAs } = require('./myPermissionsRoutes.testkit');

/** @type {Record<string, Record<string, unknown>>} */
const USERS = {
    ann: { id: 'ann', organizationId: 'orgA', orgRole: 'org_admin', groups: [] },
    bob: { id: 'bob', organizationId: 'orgGone', orgRole: 'member', groups: [] },
    cat: { id: 'cat', organizationId: 'orgBroken', orgRole: 'member', groups: [] },
    eve: { id: 'eve', organizationId: null, orgRole: '', groups: [] },
};

const answerOf = myPermissionsAs(test, {
    users: USERS,
    getOrganization: async (id) => {
        if (id === 'orgBroken') throw new Error('organisation read failed');
        return id === 'orgA' ? { id: 'orgA', name: 'Organisation A' } : null;
    },
});

test('a home organisation comes with its name', async () => {
    const body = await answerOf('ann');
    assert.deepStrictEqual(body.homeOrganization, { id: 'orgA', name: 'Organisation A' });
    assert.strictEqual(body.isHomeOrgAdmin, true);
});

test('no home organisation is null', async () => {
    assert.strictEqual((await answerOf('eve')).homeOrganization, null);
});

test('an organisation that is gone or cannot be read keeps its id with a null name', async () => {
    assert.deepStrictEqual((await answerOf('bob')).homeOrganization, { id: 'orgGone', name: null });
    const broken = await answerOf('cat');
    assert.deepStrictEqual(broken.homeOrganization, { id: 'orgBroken', name: null });
    assert.deepStrictEqual(broken.organizations, ['orgBroken'], 'the rest of the answer is served');
});
