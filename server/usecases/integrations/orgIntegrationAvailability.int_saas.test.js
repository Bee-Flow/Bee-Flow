'use strict';
/**
 * The module "int_saas" half of the integration availability tests: the GitHub sync config is
 * written through the REAL stores/githubSyncStore and read back through
 * resolveOrgIntegrationAvailability, so the shape the real store's getOrgSyncConfig returns is the
 * shape the core reads. The core file (orgIntegrationAvailability.test.js) reads it from a stand-in
 * under the same name. Shared set-up: orgIntegrationAvailability.testkit.js.
 *
 * Run: cd server && node --test usecases/integrations/orgIntegrationAvailability.int_saas.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ORG_PLAIN, ORG_NC, AZURE_TENANT, deps, useAvailabilityWorld } = require('./orgIntegrationAvailability.testkit');

let configStore;
let availability;

useAvailabilityWorld([ORG_PLAIN, ORG_NC], async (stores) => {
    configStore = stores.configStore;
    availability = require('./orgIntegrationAvailability.mts');
});

test('GitHub sync and the Microsoft directory are read for the chosen organisation', async () => {
    const before = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
    assert.equal(before.github.syncConfigured, false);
    assert.equal(before.microsoft.directoryConnected, false);

    await require('../../stores/githubSyncStore').setOrgSyncConfig(ORG_PLAIN, { repoOwner: 'owner', repoName: 'repo' });
    await configStore.setConfig('azure_group_sync_binding', { syncOrganizationId: ORG_PLAIN, syncTenantId: AZURE_TENANT });
    const av = await availability.resolveOrgIntegrationAvailability(ORG_PLAIN, {}, deps());
    assert.equal(av.github.syncConfigured, true);
    assert.equal(av.microsoft.directoryConnected, true);
    const other = await availability.resolveOrgIntegrationAvailability(ORG_NC, {}, deps());
    assert.equal(other.github.syncConfigured, false);
    assert.equal(other.microsoft.directoryConnected, false, 'the directory is bound to another organisation');
});
