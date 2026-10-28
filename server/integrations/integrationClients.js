// @typecheck strict
/**
 * The integrations feature's side of core/integrations/integrationClients.js:
 * the provider clients core's meeting notes and datatable sources talk
 * through, registered without core requiring this feature.
 *
 * Loaded at boot by boot/featureRegistrations.js. Each client is a getter, so
 * nothing below is loaded until core first asks for it.
 */

'use strict';

const { registerIntegrationClients } = require('../core/integrations/integrationClients');

registerIntegrationClients({
    google: () => require('./googleClient'),
    msGraph: () => require('./msGraphClient'),
    nextcloud: () => require('./nextcloudClient'),
    nextcloudWebdav: () => require('./nextcloudFiles/webdav'),
    nextcloudTables: () => require('./nextcloudTablesTools'),
    nextcloudTalk: () => require('./nextcloudTalkTools'),
    nextcloudCalendar: () => require('./nextcloudCalendarTools'),
    nextcloudDeck: () => require('./nextcloudDeckTools'),
    nextcloudFiles: () => require('./nextcloudTools'),
});
