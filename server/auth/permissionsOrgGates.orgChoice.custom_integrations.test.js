'use strict';

/**
 * The organisation an admin page works on, for the MCP library router of the
 * module "custom_integrations": requirePrimaryOrgAdmin
 * (auth/permissionsOrgGates.js) on /api/mcp-library/org. The world and the
 * three callers are auth/permissionsOrgGates.orgChoice.testkit.js; the core
 * routers are in auth/permissionsOrgGates.orgChoice.test.js.
 *
 * Run: cd server && node --test auth/permissionsOrgGates.orgChoice.custom_integrations.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { h, PLATFORM, seedOrganisations, closeAll, threeCallers } = require('./permissionsOrgGates.orgChoice.testkit');

/** @type {Record<string, ReturnType<typeof h.serve>>} */
const api = {};

before(async () => {
    await seedOrganisations();
    api.mcpLibrary = h.serve('/api/mcp-library', require('../routes/mcpLibrary'));
}, { timeout: 120_000 });

after(() => closeAll(api));

test('MCP library: the gate answers for org B', async () => {
    const { platform } = await threeCallers(api.mcpLibrary, 'GET', '/api/mcp-library/org');
    assert.notEqual(platform.status, 403, platform.text);
    assert.equal((await api.mcpLibrary.call('GET', '/api/mcp-library/org?orgId=org-choice-none', { user: PLATFORM })).status, 404);
});
