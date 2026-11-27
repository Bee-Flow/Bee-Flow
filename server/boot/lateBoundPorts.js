// @typecheck strict
/**
 * Late-bound ports: several lower modules call back into a higher one through a
 * setter instead of a require, to keep the import graph acyclic. The higher
 * module registers itself when it loads, but nothing guarantees it loads before
 * the first call. Registering lazy wrappers here, at boot, removes that
 * load-order dependency: the target loads on first use.
 *
 *   core/privacy/customTypes/registry.js   <- core/privacy/orgShield.js
 *   stores/configStore.js (legacy secrets) <- stores/integrationConnectionStore.js
 *   stores/user/billingPorts.js            <- core/entitlements/planEntitlements.js
 *   core/kb/embeddingMigration.js (retry)  <- core/kb/sources/index.js
 *   stores/agent/conversationStatePort.js  <- core/dlp/dlpRunner.js
 *
 * A setter whose target belongs to a first-party module is filled in that
 * module's firstParty/<id>.register.js, contributed to the channel
 * 'boot/lateBoundPorts' (modules/firstParty/registrationChannels.js) that this
 * file opens once its own are in:
 *
 *   core/tools/automationExecutorPort.js   <- core/automationRunner.js (automation)
 *   stores/user/billingPorts.js            <- services/trialService.js (billing_stripe)
 *   stores/user/seatSyncPort.js            <- services/stripeService.js (billing_stripe)
 *   stores/resourceSyncPort.js             <- services/githubSyncService.js (int_saas)
 */

'use strict';

require('../core/privacy/customTypes/registry')
    .setOrgShieldResolver((/** @type {string} */ orgId) => require('../core/privacy/orgShield').resolveOrgShield(orgId));
require('../stores/configStore')
    .setLegacySecretResolver((/** @type {string} */ key) => require('../stores/integrationConnectionStore').getLegacySecretValue(key));
require('../stores/user/billingPorts')
    .setApplyPlanToOrg((...args) => require('../core/entitlements/planEntitlements').applyPlanToOrg(...args));
require('../core/kb/embeddingMigration')
    .setSourceSync((...args) => require('../core/kb/sources').syncSource(...args));
require('../stores/agent/conversationStatePort')
    .setConversationStateCleaner((conversationId) => require('../core/dlp/dlpRunner').clearConversationState(conversationId));

require('../modules/firstParty/registrationChannels').openChannel('boot/lateBoundPorts');
