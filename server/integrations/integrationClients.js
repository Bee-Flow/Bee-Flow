// @typecheck strict
/**
 * The integrations feature's side of core/integrations/integrationClients.js:
 * the provider clients that core's meeting notes and datatable sources, the
 * automation feature's approval delivery and trigger sources, and the test
 * generator (services/testGenerator.js) talk through, registered so that none
 * of them requires this feature.
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
    nextcloudTalkBot: () => require('./nextcloudTalkBot'),
    nextcloudAdminNotify: () => require('./nextcloudAdminNotify'),
    nextcloudActivity: () => require('./nextcloudActivityTools'),
    nextcloudNotifications: () => require('./nextcloudNotificationsTools'),
    gmail: () => require('./gmailTools'),
    github: () => require('./githubTools'),
    youtrack: () => require('./youtrackTools'),
});
