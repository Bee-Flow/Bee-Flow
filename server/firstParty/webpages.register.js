// @typecheck strict
/**
 * The registrations of the first-party module "webpages": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/webpages.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // documents, webpages, KB
        'services/webpageSnapshot': () => require('../services/webpageSnapshot'),
        'stores/webpageStore': () => require('../stores/webpageStore'),
        'auth/webpagePreviewToken': () => require('../auth/webpagePreviewToken'),
        'stores/webpageStore': () => require('../stores/webpageStore'),
        'core/webpages/webpageUsageSync': () => require('../core/webpages/webpageUsageSync'),
    }));
    contribute('integrations/toolFamilies', () => {
        const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../integrations/webpageAutomationTools');
        require('../integrations/toolFamilyAdapters').registerFamilies([
            { name: 'webpage_automation', order: 530, isTool: isWebpageAutomationTool, execute: (n, a, ctx) => executeWebpageAutomationTool(n, a, { userId: ctx.userId, organizationId: ctx.orgId, userGroupIds: ctx.userGroupIds || [], userOrgIds: ctx.userOrgIds || (ctx.orgId ? [ctx.orgId] : []) }) },
        ]);
    });
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerToolsets({
        WEBPAGE_AUTOMATION_TOOLS: require('../integrations/webpageAutomationTools').WEBPAGE_AUTOMATION_TOOLS,
    }));
}

module.exports = { register };
