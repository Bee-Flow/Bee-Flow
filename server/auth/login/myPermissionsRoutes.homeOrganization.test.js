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

const h = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

const db = h.recordDb();
const permissions = require('../permissions');
const swaps = makeSwaps();

/** @type {import('express').RequestHandler} */
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'getUserPermissions', async () => []);

const userStore = require('../../stores/userStore');
const entitlements = require('../../core/entitlements/entitlements');

/** @type {Record<string, Record<string, unknown>>} */
const USERS = {
    ann: { id: 'ann', organizationId: 'orgA', orgRole: 'org_admin', groups: [] },
    bob: { id: 'bob', organizationId: 'orgGone', orgRole: 'member', groups: [] },
    cat: { id: 'cat', organizationId: 'orgBroken', orgRole: 'member', groups: [] },
    eve: { id: 'eve', organizationId: null, orgRole: '', groups: [] },
};

const api = h.serve('/auth', require('./myPermissionsRoutes'));

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => (USERS[id] ? { ...USERS[id] } : null));
    swaps.swap(userStore, 'getAllGroups', async () => []);
    swaps.swap(userStore, 'getOrganization', async (/** @type {string} */ id) => {
        if (id === 'orgBroken') throw new Error('organisation read failed');
        return id === 'orgA' ? { id: 'orgA', name: 'Organisation A' } : null;
    });
    swaps.swap(entitlements, 'resolveEntitlements', async () => ({ degraded: true }));
});
test.after(async () => {
    swaps.restore();
    await api.close();
});

/** @param {string} id */
async function answerOf(id) {
    const res = await api.call('GET', '/auth/my-permissions', { user: { id, role: 'user' } });
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
}

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
