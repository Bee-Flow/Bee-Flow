// @typecheck strict
/**
 * The registrations of the first-party module "cowork": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/cowork.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureRegistrations', () => require('../core/cowork/runnerPorts'));
}

module.exports = { register };
