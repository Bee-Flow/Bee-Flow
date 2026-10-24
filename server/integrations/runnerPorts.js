// @typecheck
/**
 * The integrations feature's side of core/automationRunner/featurePorts.js:
 * what the automation runner (core) calls in integrations/ without requiring
 * it. Loaded at boot by boot/featureRegistrations.js; every require is lazy.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

registerRunnerPorts({
    // Run notifications on the Nextcloud channel (the admin bell).
    nextcloudAdmin: {
        sendAdminNotification: (...args) => require('./nextcloudAdminNotify').sendAdminNotification(...args),
    },
    // The knowledge_write step.
    knowledgeBase: {
        executeKbIngestTool: (...args) => require('./kbIngestTools').executeKbIngestTool(...args),
    },
    // http_request credentials of a custom integration.
    customIntegrations: {
        renderAuthValue: (...args) => require('./customIntegrationRunner').renderAuthValue(...args),
    },
});
