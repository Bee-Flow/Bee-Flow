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
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'core/cowork/runActivity': () => require('../core/cowork/runActivity.mts'),
        'core/cowork/reviewTool': () => require('../core/cowork/reviewTool.mts'),
        'core/cowork/outcomeTool': () => require('../core/cowork/outcomeTool.mts'),
        'core/cowork/habits/habitSignals': () => require('../core/cowork/habits/habitSignals.mts'),
        'stores/coworkStore': () => require('../stores/coworkStore'),
    }));
    contribute('boot/featureRegistrations', () => require('../core/cowork/runnerPorts'));
}

module.exports = { register };
