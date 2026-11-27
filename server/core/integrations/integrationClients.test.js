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
const { optionalLookupContract } = require('../../testUtils/optionalLookup.testkit');

optionalLookupContract({
    kind: 'integrationClients',
    name: '_probeOptional',
    register: (value) => registry.registerIntegrationClients({ _probeOptional: () => value }),
    required: (name) => registry.integrationClient(name),
    optional: (name) => registry.optionalIntegrationClient(name),
    clear: (name) => registry._clearIntegrationClientsForTests(name),
});

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

// What callers use of each client (the list in the registry's header). The
// getters are called here, so this also proves each one loads.
const EXPECTED = {
    google: ['createGoogleApiClient'],
    msGraph: ['graphRequest', 'graphFetch'],
    nextcloud: ['resolveAuth', 'resolveNcBinding', 'isConnected', 'webdavRoot', 'downloadBinary'],
    nextcloudWebdav: ['joinDavPath', 'parsePropfind'],
    nextcloudTables: ['toWireData', 'readJsonSafe', 'describeColumn', 'mapTable'],
    nextcloudTalk: ['executeNextcloudTalkTool', 'getTalkRecordingCapability'],
    nextcloudCalendar: ['executeNextcloudCalendarTool'],
    nextcloudTalkBot: ['getBotSecret', 'postBotMessage', 'postBotReaction', 'findMessageIdByReference', 'listMessageReactions'],
    nextcloudAdminNotify: ['sendAdminNotification'],
    nextcloudActivity: ['executeNextcloudActivityTool', 'incomingShares'],
    nextcloudNotifications: ['executeNextcloudNotificationsTool'],
    gmail: ['extractAttachments'],
    github: ['executeGitHubTool'],
    youtrack: ['executeYouTrackTool'],
};

// Every client is a first-party module's (firstParty/<id>.provides.json): the composition holds
// each client of a module that is here, and asks nothing of a module that is not.
const { providerOf, moduleStateOf } = require('../../modules/firstParty/moduleState');
const here = (/** @type {string} */ name) => {
    const id = providerOf('integrationClients', name);
    return id !== null && moduleStateOf(id) !== 'absent';
};

test('integrations/integrationClients.js registers every client core asks for, of each module that is here', () => {
    require('../../integrations/integrationClients');
    for (const [name, fns] of Object.entries(EXPECTED)) {
        if (!here(name)) continue;
        const client = registry.integrationClient(name);
        for (const fn of fns) assert.strictEqual(typeof client[fn], 'function', `${name}.${fn} is missing`);
    }
    if (here('msGraph')) assert.strictEqual(typeof registry.integrationClient('msGraph').GRAPH_BASE, 'string');
    if (here('nextcloudWebdav')) assert.strictEqual(typeof registry.integrationClient('nextcloudWebdav').PROPFIND_BODY, 'string');
    if (here('nextcloudTables')) assert.strictEqual(typeof registry.integrationClient('nextcloudTables').TABLES_API, 'string');
    if (here('nextcloudTables')) assert.strictEqual(typeof registry.integrationClient('nextcloudTables').HEADERS, 'object');
    if (here('nextcloudTalkBot')) assert.strictEqual(typeof registry.integrationClient('nextcloudTalkBot').TALK_V1, 'string');
    if (here('nextcloudTalkBot')) assert.strictEqual(typeof registry.integrationClient('nextcloudTalkBot').MAX_MESSAGE_CHARS, 'number');
    if (here('nextcloud')) assert.strictEqual(typeof registry.integrationClient('nextcloud').getBaseUrl, 'function');
});

test('integrationClientNames lists every registered client name', () => {
    registry.registerIntegrationClients({ _probeNames: () => ({}) });
    assert.ok(registry.integrationClientNames().includes('_probeNames'));
    registry._clearIntegrationClientsForTests('_probeNames');
    assert.ok(!registry.integrationClientNames().includes('_probeNames'));
});
