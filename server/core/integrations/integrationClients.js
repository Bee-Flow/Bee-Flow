// @typecheck
/**
 * Integration clients: the provider API clients core code talks through,
 * injected by the integrations feature.
 *
 * Meeting notes (core/meetingNotes/) fetch recordings from Google Meet,
 * Microsoft Teams and Nextcloud Talk; the datatable sources
 * (core/dataEngine/sources/) mirror Nextcloud Tables and spreadsheet files in
 * Drive, OneDrive and Nextcloud; the automation feature posts approval cards
 * to Talk and the Nextcloud bell (automation/approvalDelivery.js) and polls
 * Gmail, Google and Nextcloud for its triggers (automation/triggerBus.js); the
 * test generator reads GitHub and YouTrack (services/testGenerator.js). The
 * clients themselves live in integrations/, a feature, and neither core nor
 * another feature may require a feature (server/ARCHITECTURE.md). So
 * integrations/integrationClients.js registers each client here at boot (it is
 * loaded by boot/featureRegistrations.js) and core asks for it by name:
 *
 *   const { integrationClient } = require('../integrations/integrationClients');
 *   const nc = integrationClient('nextcloud');   // the nextcloudClient module
 *
 * A client is registered as a GETTER, called on every lookup, so the module
 * behind it is only loaded when first used and a test's require.cache stub of
 * that module is what a lookup returns. The names, and what callers use of each:
 *
 *   google              createGoogleApiClient (the trigger bus: the whole googleClient module)
 *   msGraph             graphRequest, graphFetch, GRAPH_BASE
 *   nextcloud           resolveAuth, resolveNcBinding, isConnected, webdavRoot, downloadBinary, getBaseUrl
 *   nextcloudWebdav     joinDavPath, parsePropfind, PROPFIND_BODY
 *   nextcloudTables     TABLES_API, HEADERS, toWireData, readJsonSafe, describeColumn, mapTable,
 *                       executeNextcloudTablesTool
 *   nextcloudTalk       executeNextcloudTalkTool, getTalkRecordingCapability
 *   nextcloudCalendar   executeNextcloudCalendarTool
 *   nextcloudDeck       executeNextcloudDeckTool
 *   nextcloudFiles      the Files / tags family executor (nextcloudTools.js)
 *   nextcloudTalkBot    getBotSecret, postBotMessage, postBotReaction, findMessageIdByReference,
 *                       listMessageReactions, TALK_V1, MAX_MESSAGE_CHARS
 *   nextcloudAdminNotify  sendAdminNotification
 *   nextcloudActivity, nextcloudNotifications, gmail   the trigger pollers' tool executors
 *   github, youtrack    executeGitHubTool, executeYouTrackTool (services/testGenerator.js)
 */

'use strict';

/** name -> () => client module */
const getters = new Map();

/** Register (or replace) clients: `{ name: () => module, ... }`. */
function registerIntegrationClients(map) {
    for (const [name, get] of Object.entries(map || {})) {
        if (typeof get !== 'function') throw new TypeError(`registerIntegrationClients(${name}): a client is registered as a getter function`);
        getters.set(name, get);
    }
}

/**
 * The client module, or a thrown Error naming what was not loaded.
 * @param {string} name
 */
function integrationClient(name) {
    const get = getters.get(name);
    if (!get) {
        throw new Error(`integration client "${name}" is not registered (boot/featureRegistrations.js was not loaded)`);
    }
    return get();
}

function hasIntegrationClient(name) {
    return getters.has(name);
}

/** Test seam: drop one client, or all of them. */
function _clearIntegrationClientsForTests(name) {
    if (name) getters.delete(name);
    else getters.clear();
}

module.exports = { registerIntegrationClients, integrationClient, hasIntegrationClient, _clearIntegrationClientsForTests };
