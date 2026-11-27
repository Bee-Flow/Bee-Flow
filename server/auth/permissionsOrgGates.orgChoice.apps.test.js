'use strict';

/**
 * The organisation an admin page works on, for the App Studio router of the
 * module "apps": requirePrimaryOrgAdmin (auth/permissionsOrgGates.js) on
 * /api/studio-apps/usage. The world and the three callers are
 * auth/permissionsOrgGates.orgChoice.testkit.js; the core routers are in
 * auth/permissionsOrgGates.orgChoice.test.js.
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.apps.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { h, ORG_B, ADMIN_B, seedOrganisations, closeAll, threeCallers } = require('./permissionsOrgGates.orgChoice.testkit');

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    await seedOrganisations();
    const studioAppStore = require('../stores/studioAppStore');
    await studioAppStore.initDB();
    await require('../stores/studioAppDataStore').initDB();
    api.studioApps = h.serve('/api/studio-apps', require('../routes/studioApps/crud'));
}, { timeout: 120_000 });

after(() => closeAll(api));

test('App Studio storage: a platform admin sees the apps of org B', async () => {
    await require('../stores/studioAppStore').createStudioApp({ userId: ADMIN_B.id, organizationId: ORG_B, name: 'App of org B' });
    const { platform, own } = await threeCallers(api.studioApps, 'GET', '/api/studio-apps/usage');
    assert.equal(platform.status, 200, platform.text);
    assert.equal(platform.body.apps.length, 1);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.apps.length, 0);
});
