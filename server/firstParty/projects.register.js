// @typecheck strict
/**
 * The registrations of the first-party module "projects": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/projects.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // agents, projects
        'projects/chatModel': () => require('../projects/chatModel'),
        // a filled-in document filed into a project from the chat (integrations/templateFillTools.mts)
        'projects/documentFiling': () => require('../projects/documentFiling.mts'),
    }));
    // Account erasure's owned projects (stores/user/erasurePorts.js).
    contribute('projects/erasurePorts', () => require('../stores/user/erasurePorts').registerErasurePorts({
        projects: {
            makeTeardown: () => require('../projects/projectTeardown').makeProjectTeardown(),
        },
    }));
}

module.exports = { register };
