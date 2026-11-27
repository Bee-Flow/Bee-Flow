// @typecheck strict
/**
 * The registrations of the first-party module "compliance": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * It provides no names of the three lookup registries, so it has no provides file.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/dpiaStore': () => require('../stores/dpiaStore'),
        'compliance/kbQueryLogEvidence': () => require('../compliance/kbQueryLogEvidence'),
    }));
    // core/automationRunner/documentMarking (Art. 50(2)): core owns the port,
    // compliance owns the policy. Without it a generated document renders
    // unmarked. Wired when boot/ports.js wirePorts runs.
    contribute('boot/ports', () => require('../core/automationRunner/documentMarking')
        .setMarkingResolver((/** @type {string} */ orgId, /** @type {{ automationId?: string | null; aiStepIds?: string[]; provider?: string | null; now?: Date; } | undefined} */ info) => require('../compliance/marking').resolveMarking(orgId, info)));
}

module.exports = { register };
