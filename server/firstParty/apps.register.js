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
        'stores/studioAppStore': () => require('../stores/studioAppStore'),
        'stores/studioAppData/actionRuns': () => require('../stores/studioAppData/actionRuns.mts'),
        'stores/studioAppData/runLogStore': () => require('../stores/studioAppData/runLogStore.mts'),
        'stores/studioAppData/webhookTriggers': () => require('../stores/studioAppData/webhookTriggers.mts'),
        'stores/studioAppData/runPolicy': () => require('../stores/studioAppData/runPolicy.mts'),
        'appStudio/approvalWaits': () => require('../appStudio/approvalWaits.mts'),
        'appStudio/mcpBuilder': () => require('../appStudio/mcpBuilder'),
        'appStudio/mailboxIdentity': () => require('../appStudio/mailboxIdentity'),
        'stores/studioApp/accountErasure': () => require('../stores/studioApp/accountErasure'),
        'stores/adoption/kinds.apps': () => require('../stores/adoption/kinds.apps'),
        'core/kb/usage/apps': () => require('../core/kb/usage/apps'),
        'stores/agent/usage/apps': () => require('../stores/agent/usage/apps'),
    }));
}

module.exports = { register };
