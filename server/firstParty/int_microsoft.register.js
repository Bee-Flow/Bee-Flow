// @typecheck strict
/**
 * The registrations of the first-party module "int_microsoft": its rows of the core's
 * registries, each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/int_microsoft.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilyAdapters').ModuleToolFamily} ModuleToolFamily */
/** @typedef {import('../integrations/toolFamilies').ToolArgs} ToolArgs */
/** @typedef {import('../integrations/toolFamilies').ToolCtx} ToolCtx */
/**
 * @typedef {{ outlookSessionFor: typeof import('../integrations/outlookSession').outlookSessionFor,
 *   executeOutlookTool: typeof import('../integrations/outlookTools').executeOutlookTool }} OutlookDeps
 *   bound when the families register, as the requires at the top of integrations/toolFamilies.js were
 */

// ─── Outlook ───────────────────────────────────────────────────
// A Google (or Nextcloud) session may carry Outlook tools when the user
// connected Microsoft 365 separately (getIntegrationTools adds them off
// the vault credential). Graph must then get a Microsoft-only shim,
// never this session's foreign token; a Microsoft session passes
// through unchanged. `autoSend` follows gmail_compose exactly.
/**
 * @param {OutlookDeps} deps
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} context
 */
async function executeOutlook({ outlookSessionFor, executeOutlookTool }, toolName, toolArgs, context) {
    const msSession = await outlookSessionFor(toolArgs, context);
    return await executeOutlookTool(toolName, toolArgs, msSession, { autoSend: !!context.autoSend, mailTrigger: context.mailTrigger || null });
}

/** @returns {ModuleToolFamily[]} */
function toolFamilies() {
    const { bySession } = require('../integrations/toolFamilyAdapters');
    const { isOutlookTool, executeOutlookTool } = require('../integrations/outlookTools');
    const { outlookSessionFor } = require('../integrations/outlookSession');
    const { isMsCalendarTool, executeMsCalendarTool } = require('../integrations/msCalendarTools');
    const { isOneDriveTool, executeOneDriveTool } = require('../integrations/oneDriveTools');
    const { isMsContactsTool, executeMsContactsTool } = require('../integrations/msContactsTools');
    /** @type {OutlookDeps} */
    const outlook = { outlookSessionFor, executeOutlookTool };
    return [
        { name: 'outlook', order: 540, isTool: isOutlookTool, execute: (n, a, ctx) => executeOutlook(outlook, n, a, ctx) },
        { name: 'ms_calendar', order: 550, isTool: isMsCalendarTool, execute: bySession(executeMsCalendarTool) },
        { name: 'onedrive', order: 560, isTool: isOneDriveTool, execute: bySession(executeOneDriveTool) },
        { name: 'ms_contacts', order: 570, isTool: isMsContactsTool, execute: bySession(executeMsContactsTool) },
    ];
}

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
    }));
    contribute('integrations/toolFamilies', () => require('../integrations/toolFamilyAdapters').registerFamilies(toolFamilies()));
    contribute('integrations/coreToolsets', () => {
        const { OUTLOOK_TOOLS, OUTLOOK_READONLY_TOOLS } = require('../integrations/outlookTools');
        require('../integrations/coreToolsets').registerToolsets({
            OUTLOOK_TOOLS,
            OUTLOOK_READONLY_TOOLS,
            MS_CALENDAR_TOOLS: require('../integrations/msCalendarTools').MS_CALENDAR_TOOLS,
            ONEDRIVE_TOOLS: require('../integrations/oneDriveTools').ONEDRIVE_TOOLS,
            MS_CONTACTS_TOOLS: require('../integrations/msContactsTools').MS_CONTACTS_TOOLS,
        });
    });
    contribute('integrations/integrationClients', () => require('../core/integrations/integrationClients').registerIntegrationClients({
        msGraph: () => require('../integrations/msGraphClient'),
    }));
}

module.exports = { register };
