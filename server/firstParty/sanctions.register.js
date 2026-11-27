// @typecheck strict
/**
 * The registrations of the first-party module "sanctions": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('integrations/toolFamilies', () => require('../integrations/toolFamilyAdapters').registerFamilies([
        // sanctions: local screening, the executor re-checks the licence.
        { name: 'sanctions', order: 475, isTool: (n) => require('../integrations/sanctionsTools.mts').isSanctionsTool(n), execute: (n, a, ctx) => require('../integrations/sanctionsTools.mts').executeSanctionsTool(n, a, { userId: ctx.userId, orgId: ctx.orgId }) },
    ]));
    contribute('integrations/coreToolsets', () => {
        const { registerToolsets, registerGroupDeps } = require('../integrations/coreToolsets');
        registerToolsets({ SANCTIONS_TOOLS: require('../integrations/sanctionsTools.mts').SANCTIONS_TOOLS });
        registerGroupDeps({
            // Licence check of the sanctions tools (feature sanctions_screening), asked only once the org switch is on.
            sanctionsAccess: () => require('../core/sanctions/service.mts'),
        });
    });
}

module.exports = { register };
