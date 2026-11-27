// @typecheck strict
/**
 * The registrations of the first-party module "datatables": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/datatableStore': () => require('../stores/datatableStore'),
        'stores/datatableDbStore': () => require('../stores/datatableDbStore'),
    }));
    // The live-datatable listeners (stores/datatableStore/liveChanges.js, this module's): the
    // knowledge-source arm, public webpage snapshots and the cowork items that start on a table.
    contribute('boot/featureRegistrations', () => require('../jobs/datatableChangePorts'));
}

module.exports = { register };
