// @typecheck strict
/**
 * The registrations of the first-party module "int_google": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/int_google.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilyAdapters').ModuleToolFamily} ModuleToolFamily */

/** @returns {ModuleToolFamily[]} */
function toolFamilies() {
    const { bySession } = require('../integrations/toolFamilyAdapters');
    const { isGmailTool, executeGmailTool } = require('../integrations/gmailTools');
    const { isCalendarTool, executeCalendarTool } = require('../integrations/calendarTools');
    const { isDriveTool, executeDriveTool } = require('../integrations/driveTools');
    const { isDocsTool, executeDocsTool } = require('../integrations/docsTools');
    const { isSheetsTool, executeSheetsTool } = require('../integrations/sheetsTools');
    const { isSlidesTool, executeSlidesTool } = require('../integrations/slidesTools');
    const { isContactsTool, executeContactsTool } = require('../integrations/contactsTools');
    const { isKeepTool, executeKeepTool } = require('../integrations/keepTools');
    const { isGoogleGroupsTool, executeGoogleGroupsTool } = require('../integrations/googleGroupsTools');
    const { isMapsTool, executeMapsTool } = require('../integrations/mapsTools');
    return [
        // `autoSend` is opt-in per-call: only the automation runner sets it (no
        // user is present to confirm a draft). Direct chat / agent chat leave it
        // false so the email_draft → user approves → send flow stays.
        { name: 'gmail', order: 200, isTool: isGmailTool, execute: (n, a, ctx) => executeGmailTool(n, a, ctx.session, { autoSend: !!ctx.autoSend, mailTrigger: ctx.mailTrigger || null }) },
        // BFSF-254: pass the requester's IANA timezone through so drafts and the
        // approved create/update carry it — Google rejects bare local dateTimes
        // ("Missing time zone definition for start time").
        { name: 'google_calendar', order: 210, isTool: isCalendarTool, execute: (n, a, ctx) => executeCalendarTool(n, a, ctx.session, { timezone: ctx.timezone || null }) },
        { name: 'google_docs', order: 220, isTool: isDocsTool, execute: bySession(executeDocsTool) },
        { name: 'google_sheets', order: 230, isTool: isSheetsTool, execute: bySession(executeSheetsTool) },
        { name: 'google_slides', order: 240, isTool: isSlidesTool, execute: bySession(executeSlidesTool) },
        { name: 'google_drive', order: 250, isTool: isDriveTool, execute: (n, a, ctx) => executeDriveTool(n, a, ctx.session, { runScope: ctx.runScope || null }) },
        { name: 'google_contacts', order: 260, isTool: isContactsTool, execute: bySession(executeContactsTool) },
        { name: 'google_keep', order: 270, isTool: isKeepTool, execute: bySession(executeKeepTool) },
        { name: 'google_groups', order: 280, isTool: isGoogleGroupsTool, execute: bySession(executeGoogleGroupsTool) },
        { name: 'maps', order: 480, isTool: isMapsTool, execute: (n, a) => executeMapsTool(n, a) },
    ];
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
    }));
    contribute('integrations/toolFamilies', () => require('../integrations/toolFamilyAdapters').registerFamilies(toolFamilies()));
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerToolsets({
        GMAIL_TOOLS: require('../integrations/gmailTools').GMAIL_TOOLS,
        CALENDAR_TOOLS: require('../integrations/calendarTools').CALENDAR_TOOLS,
        DRIVE_TOOLS: require('../integrations/driveTools').DRIVE_TOOLS,
        DOCS_TOOLS: require('../integrations/docsTools').DOCS_TOOLS,
        SHEETS_TOOLS: require('../integrations/sheetsTools').SHEETS_TOOLS,
        SLIDES_TOOLS: require('../integrations/slidesTools').SLIDES_TOOLS,
        CONTACTS_TOOLS: require('../integrations/contactsTools').CONTACTS_TOOLS,
        KEEP_TOOLS: require('../integrations/keepTools').KEEP_TOOLS,
        GOOGLE_GROUPS_TOOLS: require('../integrations/googleGroupsTools').GOOGLE_GROUPS_TOOLS,
        MAPS_TOOLS: require('../integrations/mapsTools').MAPS_TOOLS,
    }));
    contribute('integrations/integrationClients', () => require('../core/integrations/integrationClients').registerIntegrationClients({
        google: () => require('../integrations/googleClient'),
        gmail: () => require('../integrations/gmailTools'),
    }));
}

module.exports = { register };
