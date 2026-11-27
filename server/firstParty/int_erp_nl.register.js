// @typecheck strict
/**
 * The registrations of the first-party module "int_erp_nl": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

/** @typedef {import('../integrations/toolFamilyAdapters').ModuleToolFamily} ModuleToolFamily */

/** @returns {ModuleToolFamily[]} */
function toolFamilies() {
    const { byUser } = require('../integrations/toolFamilyAdapters');
    const { isAfasTool, executeAfasTool } = require('../integrations/afasTools');
    const { isNmbrsTool, executeNmbrsTool } = require('../integrations/nmbrsTools');
    const { isVplanTool, executeVplanTool } = require('../integrations/vplanTools');
    return [
        { name: 'afas', order: 150, isTool: isAfasTool, execute: byUser(executeAfasTool) },
        { name: 'nmbrs', order: 160, isTool: isNmbrsTool, execute: (n, a, ctx) => executeNmbrsTool(n, a, ctx.userId, { orgId: ctx.orgId }) },
        { name: 'vplan', order: 170, isTool: isVplanTool, execute: byUser(executeVplanTool) },
        { name: 'firebird', order: 175, isTool: (n) => require('../integrations/firebirdTools').isFirebirdTool(n), execute: byUser((n, a, u) => require('../integrations/firebirdTools').executeFirebirdTool(n, a, u)) }, // lazy: the driver loads on first use
        { name: 'frappe_crm', order: 177, isTool: (n) => require('../integrations/frappeCrmTools.mts').isFrappeCrmTool(n), execute: byUser((n, a, u) => require('../integrations/frappeCrmTools.mts').executeFrappeCrmTool(n, a, u)) },
        { name: 'twoba', order: 178, isTool: (n) => n.startsWith('twoba_') && require('../integrations/twobaTools.mts').isTwobaTool(n), execute: (n, a, ctx) => require('../integrations/twobaTools.mts').executeTwobaTool(n, a, ctx.userId, { automationId: ctx.automationId || null, runScope: ctx.runScope || null }) }, // the run scope: upload a file of this run
    ];
}

function register() {
    contribute('integrations/toolFamilies', () => require('../integrations/toolFamilyAdapters').registerFamilies(toolFamilies()));
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerToolsets({
        AFAS_TOOLS: require('../integrations/afasTools').AFAS_TOOLS,
        NMBRS_TOOLS: require('../integrations/nmbrsTools').NMBRS_TOOLS,
        VPLAN_TOOLS: require('../integrations/vplanTools').VPLAN_TOOLS,
        FIREBIRD_TOOLS: require('../integrations/firebirdTools').FIREBIRD_TOOLS,
        FRAPPE_CRM_TOOLS: require('../integrations/frappeCrmTools.mts').FRAPPE_CRM_TOOLS,
        TWOBA_TOOLS: require('../integrations/twobaToolDefs.mts').TWOBA_TOOLS,
    }));
}

module.exports = { register };
