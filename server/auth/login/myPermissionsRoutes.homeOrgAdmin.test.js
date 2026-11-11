// @typecheck
/**
 * `isHomeOrgAdmin` on GET /auth/my-permissions: whether the caller administers
 * their HOME organisation by the strict check every org-admin gate and the
 * admin dashboard use (permissions._evalOrgAdmin). The SPA shows the sections
 * that need it (Monitoring > Feedback, Security > Guardrails) on this answer.
 *
 *   - an admin orgRole in the home organisation counts;
 *   - so does a group IN the home organisation that carries admin rights;
 *   - a plain group, admin rights in another organisation, or no home
 *     organisation does not.
 *
 * No module mocking: the store and the permission snapshot are swapped on their
 * module objects (testUtils/swaps) before the router is required; the decision
 * itself (_evalOrgAdmin) is the real one.
 *
 * Run: cd server && node --test auth/login/myPermissionsRoutes.homeOrgAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { myPermissionsAs } = require('./myPermissionsRoutes.testkit');

const GROUPS = [
    { id: 'g_a_plain', organizationId: 'orgA', permissions: [], roles: [] },
    { id: 'g_a_admin', organizationId: 'orgA', permissions: ['all'], roles: [] },
    { id: 'g_b_admin', organizationId: 'orgB', permissions: [], roles: ['org_admin'] },
];

/** @type {Record<string, Record<string, unknown>>} */
const USERS = {
    ann: { id: 'ann', organizationId: 'orgA', orgRole: 'org_admin', groups: [] },
    carol: { id: 'carol', organizationId: 'orgA', orgRole: 'member', groups: ['g_a_admin'] },
    dan: { id: 'dan', organizationId: 'orgA', orgRole: 'member', groups: ['g_a_plain', 'g_b_admin'] },
    eve: { id: 'eve', organizationId: null, orgRole: 'org_admin', groups: ['g_a_admin'] },
};

const answerOf = myPermissionsAs(test, { users: USERS, groups: GROUPS });

/** @param {string} id */
const flagOf = async (id) => (await answerOf(id)).isHomeOrgAdmin;

test('an admin orgRole in the home organisation counts', async () => {
    assert.strictEqual(await flagOf('ann'), true);
});

test('a group of the home organisation that carries admin rights counts', async () => {
    assert.strictEqual(await flagOf('carol'), true);
});

test('a plain group at home and admin rights in another organisation do not count', async () => {
    assert.strictEqual(await flagOf('dan'), false);
});

test('no home organisation is never an organisation admin of it', async () => {
    assert.strictEqual(await flagOf('eve'), false);
});
