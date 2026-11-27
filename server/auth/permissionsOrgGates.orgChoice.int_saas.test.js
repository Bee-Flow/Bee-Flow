'use strict';

/**
 * The organisation an admin page works on, for the GitHub sync router of the
 * module "int_saas": resolveChosenOrgId (auth/adminOrg.mts) on
 * /api/integrations/github-sync. The world and the three callers are
 * auth/permissionsOrgGates.orgChoice.testkit.js; the core routers are in
 * auth/permissionsOrgGates.orgChoice.test.js.
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.int_saas.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { h, PLATFORM, seedOrganisations, closeAll, threeCallers } = require('./permissionsOrgGates.orgChoice.testkit');

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    await seedOrganisations();
    api.githubSync = h.serve('/api/integrations/github-sync', require('../routes/integrations/githubSync'));
}, { timeout: 120_000 });

after(() => closeAll(api));

test('GitHub sync: per organisation, a platform admin reads the status of org B', async () => {
    const { platform } = await threeCallers(api.githubSync, 'GET', '/api/integrations/github-sync/status');
    assert.equal(platform.status, 200, platform.text);
    assert.equal(platform.body.configured, false);
    const unchosen = await api.githubSync.call('GET', '/api/integrations/github-sync/status', { user: PLATFORM });
    assert.equal(unchosen.status, 400, 'without a chosen organisation a platform admin has none, as before');
});
