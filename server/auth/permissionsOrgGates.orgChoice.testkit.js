// @typecheck strict
'use strict';

/**
 * The world of the "organisation an admin page works on" tests
 * (auth/permissionsOrgGates.orgChoice.test.js and its module halves,
 * permissionsOrgGates.orgChoice.<moduleId>.test.js): two organisations on one
 * plan, a platform admin, the organisation admins of A and B, real stores over
 * PGlite (testUtils/pglitePool.js), and threeCallers, which calls one route as
 * the three of them.
 *
 * Require it before anything else of the server: it sets the environment the
 * stores read when they load.
 */

const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'org-choice-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'org-choice-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');

const ORG_A = 'org-choice-a';
const ORG_B = 'org-choice-b';
const base = { role: 'user', groups: [] };
const PLATFORM = { ...base, id: 'u-choice-platform', username: 'choice-platform', email: 'p@choice.test', organizationId: ORG_A, role: 'admin', orgRole: 'member' };
const ADMIN_A = { ...base, id: 'u-choice-admin-a', username: 'choice-admin-a', email: 'a@choice.test', organizationId: ORG_A, orgRole: 'org_admin' };
const ADMIN_B = { ...base, id: 'u-choice-admin-b', username: 'choice-admin-b', email: 'b@choice.test', organizationId: ORG_B, orgRole: 'org_admin' };

/** @typedef {ReturnType<typeof h.serve>} Server */

/** The two organisations on one plan, and the three users. */
async function seedOrganisations() {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    const plan = await userStore.createPlan({ name: 'Choice plan', tier: 'enterprise', allowed_features: ['mcp_marketplace', 'apps'] });
    for (const [id, name] of [[ORG_A, 'Org A'], [ORG_B, 'Org B']]) {
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
    }
    for (const u of [PLATFORM, ADMIN_A, ADMIN_B]) await userStore.createUser({ ...u, passwordHash: 'x' });
}

/**
 * Close the servers a test file started, then the database.
 * @param {Record<string, Server>} api
 */
async function closeAll(api) {
    for (const s of Object.values(api)) await s.close();
    await closePg();
}

/**
 * The three callers of one router: [status as platform admin on B, as admin of A on B, as admin of A on their own org].
 * @param {Server} server @param {string} method @param {string} path @param {unknown} [body]
 */
async function threeCallers(server, method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const platform = await server.call(method, `${path}${sep}orgId=${ORG_B}`, { user: PLATFORM, body });
    const stranger = await server.call(method, `${path}${sep}orgId=${ORG_B}`, { user: ADMIN_A, body });
    const own = await server.call(method, path, { user: ADMIN_A, body });
    assert.equal(stranger.status, 403, `${method} ${path} as the admin of org A naming org B: ${stranger.text.slice(0, 200)}`);
    return { platform, stranger, own };
}

module.exports = { h, ORG_A, ORG_B, PLATFORM, ADMIN_A, ADMIN_B, seedOrganisations, closeAll, threeCallers };
