// @typecheck strict
/**
 * Late-bound ports: several lower modules call back into a higher one through a
 * setter instead of a require, to keep the import graph acyclic. The higher
 * module registers itself when it loads, but nothing guarantees it loads before
 * the first call. Registering lazy wrappers here, at boot, removes that
 * load-order dependency: the target loads on first use.
 *
 *   core/tools/automationExecutorPort.js   <- core/automationRunner.js
 *   core/privacy/customTypes/registry.js   <- core/privacy/orgShield.js
 *   stores/configStore.js (legacy secrets) <- stores/integrationConnectionStore.js
 *   stores/user/billingPorts.js            <- services/planEntitlements.js, services/trialService.js
 *   stores/user/seatSyncPort.js            <- services/stripeService.js
 *   core/kb/embeddingMigration.js (retry)  <- core/kb/sources/index.js
 */

'use strict';

require('../core/tools/automationExecutorPort')
    .setAutomationExecutor((...args) => require('../core/automationRunner').executeAutomation(...args));
require('../core/privacy/customTypes/registry')
    .setOrgShieldResolver((/** @type {string} */ orgId) => require('../core/privacy/orgShield').resolveOrgShield(orgId));
require('../stores/configStore')
    .setLegacySecretResolver((/** @type {string} */ key) => require('../stores/integrationConnectionStore').getLegacySecretValue(key));
require('../stores/user/billingPorts')
    .setApplyPlanToOrg((...args) => require('../services/planEntitlements').applyPlanToOrg(...args));
require('../stores/user/billingPorts')
    .setMaybeAutoGrantOrgTrial((orgId) => require('../services/trialService').maybeAutoGrantOrgTrial(orgId));
require('../stores/user/seatSyncPort')
    .setSeatSync((orgId) => require('../services/stripeService').syncSeatQuantityForOrg(orgId));
require('../core/kb/embeddingMigration')
    .setSourceSync((...args) => require('../core/kb/sources').syncSource(...args));
