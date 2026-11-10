// @typecheck
/**
 * GET /auth/my-permissions served for the tests of its home-organisation
 * answers (myPermissionsRoutes.homeOrgAdmin.test.js,
 * myPermissionsRoutes.homeOrganization.test.js).
 *
 * No module mocking: requireAuth (the session-only check) and
 * getUserPermissions (no flat permissions) are swapped on auth/permissions
 * before the router is required, and the store reads on their module objects
 * (testUtils/swaps) in `test.before`; the decisions the router makes are the
 * real ones.
 */

'use strict';

const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

/**
 * Serve the router over `users` and `groups`, with `getOrganization` in the
 * store's place when given. Returns a call of the route as one user, which
 * asserts the 200 and resolves with the body.
 * @param {typeof import('node:test')} test
 * @param {{
 *   users: Record<string, Record<string, unknown>>,
 *   groups?: Array<Record<string, unknown>>,
 *   getOrganization?: (id: string) => Promise<unknown>,
 * }} fixture
 * @returns {(id: string) => Promise<Record<string, unknown>>}
 */
function myPermissionsAs(test, { users, groups = [], getOrganization }) {
    const { db, swaps, permissions } = h.sessionGated(['requireAuth']);
    swaps.swap(permissions, 'getUserPermissions', async () => []);
    const userStore = require('../../stores/userStore');
    const entitlements = require('../../core/entitlements/entitlements');
    const api = h.serve('/auth', require('./myPermissionsRoutes'));

    test.before(async () => {
        await db.settle();
        swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => (users[id] ? { ...users[id] } : null));
        swaps.swap(userStore, 'getAllGroups', async () => groups.map((g) => ({ ...g })));
        if (getOrganization) swaps.swap(userStore, 'getOrganization', getOrganization);
        swaps.swap(entitlements, 'resolveEntitlements', async () => ({ degraded: true }));
    });
    test.after(async () => {
        swaps.restore();
        await api.close();
    });

    return async (id) => {
        const res = await api.call('GET', '/auth/my-permissions', { user: { id, role: 'user' } });
        assert.strictEqual(res.status, 200, res.text);
        return res.body;
    };
}

module.exports = { myPermissionsAs };
