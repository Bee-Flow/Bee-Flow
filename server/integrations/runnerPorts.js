// @typecheck strict
/**
 * The integrations feature's side of core/automationRunner/featurePorts.js:
 * what the automation runner (core) calls in integrations/ without requiring
 * it. Loaded at boot by boot/featureRegistrations.js; every require is lazy.
 *
 * The ports of a first-party module (the Nextcloud admin bell and image reads,
 * the credentials of a custom integration) are registered in that module's
 * firstParty/<id>.register.js, contributed to the channel
 * 'integrations/runnerPorts' (modules/firstParty/registrationChannels.js) that
 * this file opens once its own port is in.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

registerRunnerPorts({
    // The knowledge_write step.
    knowledgeBase: {
        executeKbIngestTool: (/** @type {Parameters<typeof import('./kbIngestTools').executeKbIngestTool>} */ ...args) => require('./kbIngestTools').executeKbIngestTool(...args),
    },
});

require('../modules/firstParty/registrationChannels').openChannel('integrations/runnerPorts');
