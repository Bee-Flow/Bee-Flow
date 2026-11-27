// @typecheck strict
/**
 * The registrations of the first-party module "billing_stripe": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/lateBoundPorts', () => {
        require('../stores/user/billingPorts')
            .setMaybeAutoGrantOrgTrial((orgId) => require('../services/trialService').maybeAutoGrantOrgTrial(orgId));
        require('../stores/user/seatSyncPort')
            .setSeatSync((orgId) => require('../services/stripeService').syncSeatQuantityForOrg(orgId));
    });
}

module.exports = { register };
