// @typecheck strict
/**
 * The registrations of the first-party module "support": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
    }));
    contribute('integrations/toolFamilies', () => {
        const { isSupportTool, executeSupportTool } = require('../integrations/supportTools');
        require('../integrations/toolFamilyAdapters').registerFamilies([
            { name: 'support', order: 520, isTool: isSupportTool, execute: (n, a, ctx) => executeSupportTool(n, a, { userId: ctx.userId, session: ctx.session, userAuth: ctx.userAuth, supportThreadId: ctx.supportThreadId, supportActionPolicy: ctx.userAuth?.supportActionPolicy || null }) },
        ]);
    });
}

module.exports = { register };
