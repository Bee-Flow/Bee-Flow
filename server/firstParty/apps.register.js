// @typecheck strict
/**
 * The registrations of the first-party module "apps": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/apps.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what projects/ (Blueprints, Solution stages, completeness) needs of
        // automation/ and appStudio/: features may not require each other either
        'appStudio/definitionGate': () => require('../appStudio/definitionGate.mts'),
        'appStudio/appAssets': () => require('../appStudio/appAssets.mts'),
        'appStudio/portabilityReport': () => require('../appStudio/portabilityReport.mts'),
        'appStudio/automationUsageSync': () => require('../appStudio/automationUsageSync'),
        'appStudio/triggers/deploySync': () => require('../appStudio/triggers/deploySync.mts'),
    }));
}

module.exports = { register };
