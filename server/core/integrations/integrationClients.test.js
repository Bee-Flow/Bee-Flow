// @typecheck strict
/**
 * core/integrations/integrationClients.js: the registry, and the contract that
 * integrations/integrationClients.js registers every client core asks for.
 *
 * Run: cd server && node --test core/integrations/integrationClients.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const registry = require('./integrationClients');

test('a registered client is looked up through its getter on every call', () => {
    let n = 0;
    registry.registerIntegrationClients({ _probe: () => ({ n: ++n }) });
    assert.strictEqual(registry.integrationClient('_probe').n, 1);
    assert.strictEqual(registry.integrationClient('_probe').n, 2);
    assert.ok(registry.hasIntegrationClient('_probe'));
    registry._clearIntegrationClientsForTests('_probe');
    assert.throws(() => registry.integrationClient('_probe'), /"_probe" is not registered \(boot\/featureRegistrations\.js/);
});

test('a client must be registered as a getter', () => {
    assert.throws(() => registry.registerIntegrationClients({ _bad: {} }), TypeError);
    assert.ok(!registry.hasIntegrationClient('_bad'));
});

// What core uses of each client (the list in the registry's header). The
// getters are called here, so this also proves each one loads.
const EXPECTED = {
    google: ['createGoogleApiClient'],
    msGraph: ['graphRequest', 'graphFetch'],
    nextcloud: ['resolveAuth', 'resolveNcBinding', 'isConnected', 'webdavRoot', 'downloadBinary'],
    nextcloudWebdav: ['joinDavPath', 'parsePropfind'],
    nextcloudTables: ['toWireData', 'readJsonSafe', 'describeColumn', 'mapTable'],
    nextcloudTalk: ['executeNextcloudTalkTool', 'getTalkRecordingCapability'],
    nextcloudCalendar: ['executeNextcloudCalendarTool'],
};

test('integrations/integrationClients.js registers every client core asks for', () => {
    require('../../integrations/integrationClients');
    for (const [name, fns] of Object.entries(EXPECTED)) {
        const client = registry.integrationClient(name);
        for (const fn of fns) assert.strictEqual(typeof client[fn], 'function', `${name}.${fn} is missing`);
    }
    assert.strictEqual(typeof registry.integrationClient('msGraph').GRAPH_BASE, 'string');
    assert.strictEqual(typeof registry.integrationClient('nextcloudWebdav').PROPFIND_BODY, 'string');
    assert.strictEqual(typeof registry.integrationClient('nextcloudTables').TABLES_API, 'string');
    assert.strictEqual(typeof registry.integrationClient('nextcloudTables').HEADERS, 'object');
});
