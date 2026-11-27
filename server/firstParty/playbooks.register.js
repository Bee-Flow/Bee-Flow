// @typecheck strict
/**
 * The registrations of the first-party module "playbooks": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/playbooks.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/playbookStore': () => require('../stores/playbookStore'),
        'stores/adoption/kinds.playbooks': () => require('../stores/adoption/kinds.playbooks'),
    }));
}

module.exports = { register };
