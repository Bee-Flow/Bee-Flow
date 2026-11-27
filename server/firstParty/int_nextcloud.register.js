// @typecheck strict
/**
 * The registrations of the first-party module "int_nextcloud": its rows of the core's
 * registries, each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/int_nextcloud.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function registerToolFamily() {
    const { executeNextcloudFamilyTool, executeGuardedNextcloudTool, isNextcloudFamilyToolName } = require('../integrations/nextcloudToolFamily');
    require('../integrations/toolFamilyAdapters').registerFamilies([
        { name: 'nextcloud', order: 510, isTool: isNextcloudFamilyToolName, execute: executeGuardedNextcloudTool, executeFamily: executeNextcloudFamilyTool },
    ]);
}

function registerToolsets() {
    const { registerToolsets: toolsets, registerGroupDeps } = require('../integrations/coreToolsets');
    const { NEXTCLOUD_TOOLS, NEXTCLOUD_REQUEST_TOOLS } = require('../integrations/nextcloudTools');
    toolsets({
        NEXTCLOUD_TOOLS,
        // Automation steps only (core/integrations/integrationToolFeatures.js addNextcloudTools).
        NEXTCLOUD_REQUEST_TOOLS,
        NEXTCLOUD_CALENDAR_TOOLS: require('../integrations/nextcloudCalendarTools').NEXTCLOUD_CALENDAR_TOOLS,
        NEXTCLOUD_CONTACTS_TOOLS: require('../integrations/nextcloudContactsTools').NEXTCLOUD_CONTACTS_TOOLS,
        NEXTCLOUD_DECK_TOOLS: require('../integrations/nextcloudDeckTools').NEXTCLOUD_DECK_TOOLS,
        NEXTCLOUD_NOTIFICATIONS_TOOLS: require('../integrations/nextcloudNotificationsTools').NEXTCLOUD_NOTIFICATIONS_TOOLS,
        NEXTCLOUD_TALK_TOOLS: require('../integrations/nextcloudTalkTools').NEXTCLOUD_TALK_TOOLS,
        NEXTCLOUD_TASKS_TOOLS: require('../integrations/nextcloudTasksTools').NEXTCLOUD_TASKS_TOOLS,
        NEXTCLOUD_NOTES_TOOLS: require('../integrations/nextcloudNotesTools').NEXTCLOUD_NOTES_TOOLS,
        NEXTCLOUD_MAIL_TOOLS: require('../integrations/nextcloudMailTools').NEXTCLOUD_MAIL_TOOLS,
        NEXTCLOUD_ACTIVITY_TOOLS: require('../integrations/nextcloudActivityTools').NEXTCLOUD_ACTIVITY_TOOLS,
        NEXTCLOUD_TABLES_TOOLS: require('../integrations/nextcloudTablesTools').NEXTCLOUD_TABLES_TOOLS,
        NEXTCLOUD_FORMS_TOOLS: require('../integrations/nextcloudFormsTools').NEXTCLOUD_FORMS_TOOLS,
        NEXTCLOUD_TEAMS_TOOLS: require('../integrations/nextcloudTeamsTools').NEXTCLOUD_TEAMS_TOOLS,
        NEXTCLOUD_STATUS_TOOLS: require('../integrations/nextcloudStatusTools').NEXTCLOUD_STATUS_TOOLS,
    });
    registerGroupDeps({
        nextcloudClient: () => require('../integrations/nextcloudClient'),
        nextcloudCapabilities: () => require('../integrations/nextcloudCapabilities.mts'),
    });
}

function registerClients() {
    require('../core/integrations/integrationClients').registerIntegrationClients({
        nextcloud: () => require('../integrations/nextcloudClient'),
        nextcloudWebdav: () => require('../integrations/nextcloudFiles/webdav'),
        nextcloudTables: () => require('../integrations/nextcloudTablesTools'),
        nextcloudTalk: () => require('../integrations/nextcloudTalkTools'),
        nextcloudCalendar: () => require('../integrations/nextcloudCalendarTools'),
        nextcloudMail: () => require('../integrations/nextcloudMailTools'),
        nextcloudDeck: () => require('../integrations/nextcloudDeckTools'),
        nextcloudFiles: () => require('../integrations/nextcloudTools'),
        nextcloudTalkBot: () => require('../integrations/nextcloudTalkBot'),
        nextcloudAdminNotify: () => require('../integrations/nextcloudAdminNotify'),
        nextcloudActivity: () => require('../integrations/nextcloudActivityTools'),
        nextcloudNotifications: () => require('../integrations/nextcloudNotificationsTools'),
    });
}

function registerPorts() {
    require('../core/automationRunner/featurePorts').registerRunnerPorts({
        // Run notifications on the Nextcloud channel (the admin bell).
        nextcloudAdmin: {
            sendAdminNotification: (/** @type {Parameters<typeof import('../integrations/nextcloudAdminNotify').sendAdminNotification>} */ ...args) => require('../integrations/nextcloudAdminNotify').sendAdminNotification(...args),
        },
        // The image an ai_step / data_extraction step shows a model (core/automationRunner/aiStepImages.mts).
        nextcloudFiles: {
            loadNextcloudImage: (/** @type {Parameters<typeof import('../integrations/nextcloudTools').loadNextcloudImage>} */ ...args) => require('../integrations/nextcloudTools').loadNextcloudImage(...args),
        },
    });
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'integrations/nextcloudToolFamily': () => require('../integrations/nextcloudToolFamily'),
    }));
    contribute('integrations/toolFamilies', registerToolFamily);
    contribute('integrations/coreToolsets', registerToolsets);
    contribute('integrations/integrationClients', registerClients);
    contribute('integrations/runnerPorts', registerPorts);
}

module.exports = { register };
